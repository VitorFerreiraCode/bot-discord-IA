export interface FreeModel {
  id: string;
  name: string;
}

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  architecture?: { output_modalities?: unknown };
}

interface ModelsResponse {
  data?: OpenRouterModel[];
}

let freeModelCache: { expiresAt: number; models: FreeModel[] } | null = null;

function headers(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://discord.com',
    'X-Title': 'Bot Discord IA',
  };
}

export async function listFreeChatModels(apiKey: string, forceRefresh = false): Promise<FreeModel[]> {
  if (!forceRefresh && freeModelCache && freeModelCache.expiresAt > Date.now()) return freeModelCache.models;

  const response = await fetch(
    'https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=tools&sort=top-weekly',
    { headers: headers(apiKey), signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`OPENROUTER_MODELS_HTTP_${response.status}`);
  const body = await response.json() as ModelsResponse;
  const models = (body.data ?? [])
    .filter((model) => Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0)
    .filter((model) => Array.isArray(model.supported_parameters) && model.supported_parameters.includes('tools'))
    .filter((model) => typeof model.id === 'string' && model.id !== 'openrouter/free' && typeof model.name === 'string')
    .map((model) => ({ id: model.id as string, name: model.name as string }))
    .slice(0, 24);
  freeModelCache = { expiresAt: Date.now() + 5 * 60_000, models };
  return models;
}

export async function validateOpenRouterKey(apiKey: string): Promise<void> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'OPENROUTER_KEY_INVALID' : `OPENROUTER_KEY_CHECK_HTTP_${response.status}`);
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  inputTokens: number;
  outputTokens: number;
}

export async function createChatCompletion(input: {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  tools: unknown[];
}): Promise<ChatCompletionResult> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: headers(input.apiKey),
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: input.tools,
      tool_choice: 'required',
      max_tokens: input.maxOutputTokens,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let detail = errorBody;
    try {
      const parsed = JSON.parse(errorBody) as { error?: { message?: unknown; code?: unknown } };
      const apiError = parsed.error;
      if (apiError) detail = [apiError.code, apiError.message].filter((part) => part !== undefined).join(': ');
    } catch {
      // Keep the raw response text for diagnostics when the provider returns non-JSON.
    }
    throw new Error(`OPENROUTER_CHAT_HTTP_${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
  }
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0]?.message;
  return {
    content: typeof choice?.content === 'string' ? choice.content : '',
    toolCalls: (choice?.tool_calls ?? []).flatMap((call) => {
      const name = call.function?.name;
      const args = call.function?.arguments;
      return name && args ? [{ name, arguments: args }] : [];
    }),
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}
