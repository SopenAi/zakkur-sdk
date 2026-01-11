class ZakkurError extends Error {
    constructor(message, status, code, details = null) {
        super(message);
        this.name = 'ZakkurError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

class Zakkur {
    #apiKey;
    #baseUrl;
    #config;

    constructor({ 
        apiKey, 
        baseUrl = 'http://localhost:8080/api', 
        timeout = 30000, 
        retries = 3 
    }) {
        if (!apiKey) throw new ZakkurError("API Key is missing", 400, 'AUTH_REQUIRED');

        this.#apiKey = apiKey;
        this.#baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        this.#config = { timeout, retries };
        this.version = '3.0.0';

        this.board = this.#initBoardModule();
        this.agents = this.#initAgentsProxy();
        this.knowledge = this.#initKnowledgeModule();
    }

    async #executeRequest(endpoint, method = 'GET', payload = null, isFileUpload = false) {
        const url = `${this.#baseUrl}${endpoint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.#config.timeout);

        let headers = {
            'x-api-key': this.#apiKey,
            'X-SDK-Version': this.version,
            'X-SDK-Client': typeof window !== 'undefined' ? 'Browser' : 'Node.js'
        };

        let body = null;

        if (isFileUpload) {
            body = payload;
        } else if (payload) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(payload);
        }

        let attempt = 0;
        const maxAttempts = this.#config.retries;

        while (attempt <= maxAttempts) {
            try {
                const response = await fetch(url, { method, headers, body, signal: controller.signal });
                clearTimeout(timeoutId);

                const result = await response.json();

                if (!response.ok) {
                    if ([429, 503].includes(response.status) && attempt < maxAttempts) {
                        attempt++;
                        const backoff = Math.pow(2, attempt) * 1000;
                        await new Promise(r => setTimeout(r, backoff));
                        continue;
                    }

                    throw new ZakkurError(
                        result.message || "Upstream server error",
                        response.status,
                        result.code || 'UPSTREAM_ERROR',
                        result.errors
                    );
                }

                return result;

            } catch (error) {
                clearTimeout(timeoutId);
                if (error.name === 'AbortError') throw new ZakkurError("Request Timeout", 408, 'TIMEOUT');
                if (error instanceof ZakkurError) throw error;
                if (attempt >= maxAttempts) throw new ZakkurError(error.message, 500, 'NET_ERROR');
                
                attempt++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    #initBoardModule() {
        return {
            consult: (context) => this.#executeRequest('/decision', 'POST', { context }),
            getHistory: () => this.#executeRequest('/history', 'GET')
        };
    }

    #initAgentsProxy() {
        const self = this;
        return new Proxy({}, {
            get(target, role) {
                const agentRole = role.toLowerCase();
                return {
                    consult: (prompt, options = {}) => 
                        self.#executeRequest(`/agent/${agentRole}/consult`, 'POST', { 
                            context: prompt, 
                            threadId: options.threadId 
                        }),
                    execute: (task, options = {}) => 
                        self.#executeRequest(`/agent/${agentRole}/execute`, 'POST', { 
                            task: task, 
                            threadId: options.threadId 
                        })
                };
            }
        });
    }

    #initKnowledgeModule() {
        return {
            upload: (fileObject, title = null) => {
                const formData = new FormData();
                formData.append('file', fileObject);
                if (title) formData.append('title', title);
                return this.#executeRequest('/knowledge/upload', 'POST', formData, true);
            },
            list: () => this.#executeRequest('/knowledge', 'GET'),
            delete: (docId) => this.#executeRequest(`/knowledge/${docId}`, 'DELETE')
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Zakkur;
} else {
    window.Zakkur = Zakkur;
}