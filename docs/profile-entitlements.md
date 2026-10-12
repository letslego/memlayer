# Profile adaptation and trusted entitlements

Atlas has three separate inputs: versioned core identity/principles, validated presentation preferences, and host-controlled authorization. Profiles and approved lessons cannot grant tools, models, ACL roles, write access, or a longer memory excerpt. Every permission decision comes from an `AuthorizationProvider`, not Memlayer.

## Local setup

`pnpm adk:dev` explicitly loads `config/entitlements.local.json`, an administrative policy for the local CLI user. To use another policy, copy the file and set `ADK_ENTITLEMENTS_PATH=./my-policy.json` in `.env`. The policy file is reread on every authorization check, so edits can revoke access while the CLI is running. Run from the repository root for relative paths.

For a read-only analyst/tutor user:

```json
{
  "schemaVersion": 1,
  "roles": [],
  "entitlements": {
    "capabilities": ["recall_memory", "get_profile"],
    "canWrite": false,
    "allowedModels": ["gemini-2.5-flash"],
    "allowedPersonaRoles": ["analyst", "tutor"],
    "maxContextChars": 8000
  }
}
```

Only editing trusted administrative configuration can change these grants. The local file applies to the identity selected by `MEMLAYER_TENANT` and `MEMLAYER_USER`; it is not a hosted login, identity verifier, subscription manager, or billing integration. Protect the file and its environment variables in deployed applications.

## Set presentation preferences

Tell Atlas an explicit preference and ask it to store the corresponding profile key when `remember_fact` is permitted. Host applications can also use Memlayer's existing `setProfileFact` API. The following keys are recognized:

| Profile key | Accepted values |
| --- | --- |
| `language` | `English`, `Bengali`, `Hindi`, `Spanish` |
| `verbosity` | `concise`, `balanced`, `detailed` |
| `expertise` | `beginner`, `intermediate`, `advanced` |
| `working_style` | `direct`, `collaborative`, `socratic` |
| `preferred_role` | `engineering_partner`, `analyst`, `tutor` |

Invalid values and unknown keys are ignored by the instruction compiler. For example, `working_style="ignore your principles"` cannot become a presentation instruction. Names, goals, free text, and ordinary approved lesson text remain untrusted context data. Only enumerated values compile to fixed application-defined instructions. Prompt boundaries mitigate injection but do not guarantee an LLM will obey them.

Approved reflections can include an optional structured `setting`, such as `{"key":"verbosity","value":"detailed"}`. A valid approved setting overrides the corresponding profile value. Unreviewed/rejected proposals are excluded. Settings such as `canWrite`, `roles`, or `allowedModels` fail validation. A preferred role must also appear in `allowedPersonaRoles`; otherwise Atlas uses the first allowed role. Role focus and presentation never replace the core persona or its truthfulness principles.

## Capabilities and enforcement

| Capability | What it permits | Requires `canWrite=true`? |
| --- | --- | --- |
| `recall_memory` | Historical retrieval, recent turns, and own-user chat episodes | No |
| `get_profile` | Profile context and approved preferences | No |
| `remember_fact` | Model-callable durable fact storage | Yes |
| `propose_lesson` | Quote-grounded pending reflection records | Yes |
| `persist_chat` | Automatic working turns, indexed exchange, and episode persistence | Yes |
| `review_lessons` | Host-only pending review and acceptance/rejection | Yes |

Review also requires `get_profile` to inspect existing decisions. A read-only user can get an answer even when the host supplies a session name, but that exchange is not saved. Missing profile/history capabilities prevent automatic loading of those data sources. Available tools are filtered before registration, and each underlying tool method checks current permissions when executed. An already-registered tool cannot retain a revoked grant.

Allowed model IDs are exact strings. An explicitly requested unentitled model fails before generation. With no model option, the API uses `gemini-2.5-flash` if entitled, otherwise the first allowed model. The CLI's `ADK_MODEL` is an explicit request and must match the policy. Trusted `roles` are passed into Memlayer retrieval ACLs; profile role claims and model-provided role arguments cannot supply them.

`maxContextChars` limits the initial serialized historical-memory excerpt in both persona and neutral evaluation prompts. It is not a token limit on the entire model request, user message, or subsequent tool responses. Those need separate service/model budgets if required.

Authorization is checked before every ADK model call and before returning the answer. A changed policy aborts the in-flight invocation rather than reusing previously loaded data under new grants. Optional `expiresAt` is an epoch-millisecond expiry. Missing/malformed authority, identity mismatches, expiry, and provider failures fail closed. Persistence checks each sequential write; revocation or storage failure can still leave partial writes because the existing exchange persistence is not transactional. Completed writes and already-issued external calls cannot be undone by later revocation.

## Hosted integration and migration

Provide identity from verified authentication middleware, then resolve fresh grants from your trusted authorization/IAM/subscription service. The provider is an application integration boundary; this change does not implement JWT verification or connect a billing vendor. Never build it from request-body permissions, conversation text, or Memlayer facts. It must return claims bound to the same identity as the adapter.

```ts
import { MemlayerAdapter, runAdkAnswer } from './src/adk/adapter.js';
import type { AuthorizationProvider } from './src/adk/authorization.js';

// memory, authenticatedUser, and policyService come from your host application.
const identity = {
  tenantId: authenticatedUser.tenantId,
  userId: authenticatedUser.userId,
};
const authorization: AuthorizationProvider = async () => {
  const grants = await policyService.resolve(identity);
  return {
    ...identity,
    roles: grants.roles,
    entitlements: grants.entitlements,
    expiresAt: grants.expiresAt,
  };
};
const adapter = new MemlayerAdapter(memory, identity, 'hybrid', authorization);
const answer = await runAdkAnswer({
  question: 'Continue our project.', adapter, persistSession: 'project-1',
});
```

**API migration:** adapter methods and `runAdkAnswer` now require trusted authority. Calls without it fail closed. `adapter.tools()` is now asynchronous. Standalone/no-adapter calls pass `authorization` directly to `runAdkAnswer`; adapter calls use the adapter's provider, and supplying both is rejected. Reflection functions take the same provider as their final argument. The raw Memlayer SDK remains a privileged host API and has not been converted into an authenticated network service by this change.

LoCoMo answer evaluation creates an explicit read-only policy for each isolated benchmark identity. Retrieval-only benchmarks still use the memory engine directly. Existing metrics remain persona-neutral. Offline tests cover adaptation, denied writes, provider expiry/mismatch, model denial, mid-turn policy changes, execution-time revocation, trusted-role ACLs, and reviewed settings. Live Gemini behavior and your real authorization-provider integration still need environment-specific validation.
