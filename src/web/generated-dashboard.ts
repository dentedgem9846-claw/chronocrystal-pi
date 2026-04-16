// Auto-generated - do not edit
export const EMBEDDED_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChronoCrystal Dashboard</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f5f5f5;
            color: #333;
            line-height: 1.6;
            padding: 2rem;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        h1 {
            margin-bottom: 1.5rem;
            color: #1a1a1a;
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .card h2 {
            font-size: 1.1rem;
            margin-bottom: 1rem;
            color: #444;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
            color: #555;
        }
        select, input[type="text"], input[type="password"] {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 1rem;
            margin-bottom: 1rem;
        }
        select:focus, input:focus {
            outline: none;
            border-color: #007bff;
        }
        button {
            background: #007bff;
            color: white;
            border: none;
            padding: 0.75rem 1.5rem;
            border-radius: 4px;
            font-size: 1rem;
            cursor: pointer;
            transition: background 0.2s;
        }
        button:hover {
            background: #0056b3;
        }
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .message {
            padding: 0.75rem;
            border-radius: 4px;
            margin-top: 0.5rem;
            display: none;
        }
        .message.success {
            background: #d4edda;
            color: #155724;
            display: block;
        }
        .message.error {
            background: #f8d7da;
            color: #721c24;
            display: block;
        }
        .status {
            font-size: 0.875rem;
            color: #666;
            margin-top: 0.5rem;
        }
        .model-list {
            list-style: none;
            border: 1px solid #eee;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
        }
        .model-list li {
            padding: 0.5rem 0.75rem;
            border-bottom: 1px solid #eee;
            cursor: pointer;
        }
        .model-list li:hover {
            background: #f8f9fa;
        }
        .model-list li.selected {
            background: #e7f3ff;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>ChronoCrystal Dashboard</h1>

        <div class="card">
            <h2>AI Provider Configuration</h2>
            
            <label for="provider">Provider</label>
            <select id="provider">
                <option value="">Loading providers...</option>
            </select>

            <label for="model">Model</label>
            <select id="model" disabled>
                <option value="">Select a provider first</option>
            </select>

            <button id="saveConfig" disabled>Save Configuration</button>
            <div id="configMessage" class="message"></div>
        </div>

        <div class="card">
            <h2>API Key</h2>
            
            <label for="apiKey">API Key</label>
            <input type="password" id="apiKey" placeholder="Enter your API key">
            
            <button id="saveKey" disabled>Save API Key</button>
            <div id="keyMessage" class="message"></div>
            <div id="keyStatus" class="status"></div>
        </div>

        <div class="card">
            <h2>Current Configuration</h2>
            <div id="currentConfig">
                <p>Loading...</p>
            </div>
        </div>
    </div>

    <script>
        const providerSelect = document.getElementById("provider");
        const modelSelect = document.getElementById("model");
        const apiKeyInput = document.getElementById("apiKey");
        const saveConfigBtn = document.getElementById("saveConfig");
        const saveKeyBtn = document.getElementById("saveKey");
        const configMessage = document.getElementById("configMessage");
        const keyMessage = document.getElementById("keyMessage");
        const keyStatus = document.getElementById("keyStatus");
        const currentConfigDiv = document.getElementById("currentConfig");

        let providers = [];
        let selectedProvider = "";
        let selectedModel = "";

        // Load providers on init
        async function loadProviders() {
            try {
                const res = await fetch("/api/providers");
                const data = await res.json();
                providers = data.providers || [];
                
                providerSelect.innerHTML = providers
                    .map(p => \`<option value="\${p}">\${p}</option>\`)
                    .join("");
                
                if (providers.length > 0) {
                    providerSelect.value = providers[0];
                    await loadModels(providers[0]);
                }
            } catch (err) {
                console.error("Failed to load providers:", err);
                providerSelect.innerHTML = '<option value="">Failed to load</option>';
            }
        }

        // Load models for a provider
        async function loadModels(provider) {
            modelSelect.disabled = true;
            modelSelect.innerHTML = '<option value="">Loading models...</option>';
            selectedProvider = provider;

            try {
                const res = await fetch(\`/api/models/\${encodeURIComponent(provider)}\`);
                const data = await res.json();
                
                if (data.models) {
                    const models = data.models;
                    modelSelect.innerHTML = models
                        .map(m => \`<option value="\${m}">\${m}</option>\`)
                        .join("");
                    
                    // Auto-select first model if available
                    if (models.length > 0) {
                        modelSelect.value = models[0];
                        selectedModel = models[0];
                        saveConfigBtn.disabled = false;
                    }
                } else {
                    modelSelect.innerHTML = '<option value="">No models available</option>';
                }
            } catch (err) {
                console.error("Failed to load models:", err);
                modelSelect.innerHTML = '<option value="">Failed to load</option>';
            }
            
            modelSelect.disabled = false;

            // Check if we have an API key for this provider
            await checkApiKey(provider);
        }

        // Check if we have an API key for the current provider
        async function checkApiKey(provider) {
            try {
                const res = await fetch(\`/api/keys/\${encodeURIComponent(provider)}\`);
                const data = await res.json();
                
                if (data.hasKey) {
                    keyStatus.textContent = "API key is stored for this provider";
                    saveKeyBtn.disabled = false;
                } else {
                    keyStatus.textContent = "No API key stored for this provider";
                    saveKeyBtn.disabled = false;
                }
            } catch (err) {
                keyStatus.textContent = "";
                saveKeyBtn.disabled = false;
            }

            // Also load existing API key if any
            apiKeyInput.value = "";
        }

        // Load current config
        async function loadConfig() {
            try {
                const res = await fetch("/api/config");
                const data = await res.json();
                
                if (data.config) {
                    const cfg = data.config;
                    currentConfigDiv.innerHTML = \`
                        <p><strong>Provider:</strong> \${cfg.provider}</p>
                        <p><strong>Model:</strong> \${cfg.modelId}</p>
                    \`;
                    
                    // Select in dropdowns
                    if (providers.includes(cfg.provider)) {
                        providerSelect.value = cfg.provider;
                        await loadModels(cfg.provider);
                        modelSelect.value = cfg.modelId;
                        selectedModel = cfg.modelId;
                    }
                }
            } catch (err) {
                console.error("Failed to load config:", err);
            }
        }

        // Save configuration
        async function saveConfig() {
            const provider = providerSelect.value;
            const modelId = modelSelect.value;

            if (!provider || !modelId) {
                showMessage(configMessage, "Please select a provider and model", "error");
                return;
            }

            try {
                const res = await fetch("/api/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider, modelId })
                });
                
                const data = await res.json();
                
                if (data.success) {
                    showMessage(configMessage, "Configuration saved!", "success");
                    await loadConfig();
                } else {
                    showMessage(configMessage, data.error || "Failed to save", "error");
                }
            } catch (err) {
                showMessage(configMessage, "Failed to save configuration", "error");
            }
        }

        // Save API key
        async function saveApiKey() {
            const provider = providerSelect.value;
            const apiKey = apiKeyInput.value.trim();

            if (!provider) {
                showMessage(keyMessage, "Please select a provider first", "error");
                return;
            }

            if (!apiKey) {
                showMessage(keyMessage, "Please enter an API key", "error");
                return;
            }

            try {
                const res = await fetch("/api/keys", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider, apiKey })
                });
                
                const data = await res.json();
                
                if (data.success) {
                    showMessage(keyMessage, "API key saved!", "success");
                    apiKeyInput.value = "";
                    await checkApiKey(provider);
                } else {
                    showMessage(keyMessage, data.error || "Failed to save", "error");
                }
            } catch (err) {
                showMessage(keyMessage, "Failed to save API key", "error");
            }
        }

        // Show message helper
        function showMessage(el, text, type) {
            el.textContent = text;
            el.className = "message " + type;
            setTimeout(() => {
                el.className = "message";
            }, 3000);
        }

        // Event listeners
        providerSelect.addEventListener("change", () => {
            loadModels(providerSelect.value);
        });

        modelSelect.addEventListener("change", () => {
            selectedModel = modelSelect.value;
        });

        saveConfigBtn.addEventListener("click", saveConfig);
        saveKeyBtn.addEventListener("click", saveApiKey);

        // Initial load
        loadProviders();
        loadConfig();
    </script>
</body>
</html>`;
