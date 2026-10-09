export const API_PRESETS = {
  deepseek: {
    name: "DeepSeek API",
    protocol: "chat",
    baseUrl: "https://api.deepseek.com",
    tokenEnv: "DEEPSEEK_API_KEY",
  },
  openai: {
    name: "OpenAI API",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    tokenEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    name: "Anthropic API",
    protocol: "messages",
    baseUrl: "https://api.anthropic.com/v1",
    tokenEnv: "ANTHROPIC_API_KEY",
  },
};
