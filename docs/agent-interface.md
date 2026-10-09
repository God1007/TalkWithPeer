# Agent adapter interface

An adapter is instantiated for one member. The platform owns a stable local_session. Native/remote session IDs are separate per-request trace identifiers; native adapters do not resume hidden history.

## Capability discovery

A provider returns its ID, name, protocol kind, connection state and models. A parameter descriptor names either an enum with options or an integer with type=number, min and max. Unsupported values and parameters are rejected by the shared validator.

Native discovery is in server/catalog.mjs. A2A discovery uses an Agent Card through @a2a-js/sdk. Direct APIs use the models endpoint in server/api-adapter.mjs.

## Execution

    new Adapter(cwd, {model, parameters, localSession})
    adapter.run(prompt, onDelta, onActivity, signal)
    // => {text, sessionId, model, usage?}
    adapter.close()

run starts one native turn and rejects on failure, missing output, cancellation or timeout. It never replaces failure with a fabricated reply.

onDelta receives public text. onActivity receives strings or public event objects:

    {type: "session", sessionId, text}
    {type: "reasoning-summary", text}

A reasoning-summary is provider-disclosed, not raw private reasoning. Credentials and sensitive diagnostics must not be included.

signal requests cancellation. close releases local processes or cancels an active remote task. The caller persists sessionId as remoteSession, not as platform memory. Each request receives the ContextManager projection; native drivers close after each request. Direct API calls are stateless and record reported usage.

Adapters may expose countTokens(prompt, signal) for provider input counting and inputMetadata() for secret-free transport configuration. Missing count endpoints return null; authentication errors remain errors. API metadata includes platform policy instructions and resolved parameters, never auth headers. The engine owns bounded public-evidence retrieval, format repair, coordinated overflow recovery and request auditing; adapters do not maintain shared memory.

## Discussion responses

Independent opinion:

    {message, proposal}

Candidate judgment:

    {
      message,
      candidateId,
      stance: "accept" | "revise" | "reject",
      acceptsSolution: boolean,
      proposal: string | null,
      disagreements: [{memberId, reason, nonNegotiable: boolean}]
    }

acceptsSolution means willingness to use the candidate as an answer to the current user request, including explanations and comparisons. It must not be judged against an older overall project goal. When the current request needs an actionable solution, merely acknowledging a disagreement record has acceptsSolution=false. Conflicts remain explicit until positions change. Results carry requestSourceId and taskRevision; candidate IDs prevent old judgments from being reused after revisions.

Malformed responses get one constrained format retry. Continuing failure pauses the conversation. A terminal result requires valid judgments from every active participant.

## A2A model configuration

Plain A2A agents use their default model. Agents exposing selection advertise a capability extension:

    urn:talkwithpeer:model-config:1

Its params.models uses the native model descriptor schema. Configuration is sent through standard request metadata:

    {talkwithpeer: {model, parameters}}

Agents honor only configurations they advertise. This does not change A2A messages, tasks, cancellation or contextId.

Card and service endpoints must be same-origin. Bearer authentication comes from the configured local environment variable and is forwarded only to that origin.
