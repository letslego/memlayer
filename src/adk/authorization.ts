import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { requireId, requireLabel } from '../validate.js';

export const capabilitySchema = z.enum(['recall_memory','get_profile','remember_fact','propose_lesson','persist_chat','review_lessons']);
export type Capability = z.infer<typeof capabilitySchema>;
export const roleSchema = z.enum(['engineering_partner','analyst','tutor']);
export type PersonaRole = z.infer<typeof roleSchema>;
export const entitlementsSchema = z.object({
  capabilities:z.array(capabilitySchema).max(6), canWrite:z.boolean(),
  allowedModels:z.array(z.string().min(1).max(120)).min(1).max(20),
  allowedPersonaRoles:z.array(roleSchema).min(1).max(3),
  maxContextChars:z.number().int().min(1000).max(24000),
}).strict();
const authorizationSchema = z.object({
  tenantId:z.string(), userId:z.string(), roles:z.array(z.string()).max(50),
  entitlements:entitlementsSchema, expiresAt:z.number().finite().optional(),
}).strict();
export type AuthorizationContext = z.infer<typeof authorizationSchema>;
export type AuthorizationProvider = () => Promise<AuthorizationContext>;
export class AuthorizationError extends Error {
  constructor(message='Permission denied') { super(message); this.name='AuthorizationError'; }
}
export async function resolveAuthorization(provider?: AuthorizationProvider, identity?: {tenantId:string;userId:string}) {
  if (!provider) throw new AuthorizationError('A trusted authorization provider is required');
  const result = authorizationSchema.safeParse(await provider());
  if (!result.success) throw new AuthorizationError('Invalid authorization context');
  const context = result.data;
  requireId(context.tenantId,'tenantId');requireId(context.userId,'userId');
  context.roles.forEach(role=>requireLabel(role,'role'));
  if (identity && (context.tenantId!==identity.tenantId || context.userId!==identity.userId)) throw new AuthorizationError('Authorization identity mismatch');
  if (context.expiresAt!==undefined && context.expiresAt<=Date.now()) throw new AuthorizationError('Authorization expired');
  return context;
}
const writes = new Set<Capability>(['remember_fact','propose_lesson','persist_chat','review_lessons']);
export function permits(context:AuthorizationContext, capability:Capability):boolean {
  return context.entitlements.capabilities.includes(capability) && (!writes.has(capability)||context.entitlements.canWrite);
}
export function assertCapability(context:AuthorizationContext, capability:Capability) {
  if (!permits(context,capability)) throw new AuthorizationError(`Permission denied: ${capability}`);
}
export async function requireCapability(provider:AuthorizationProvider|undefined, identity:{tenantId:string;userId:string}, capability:Capability) {
  const context = await resolveAuthorization(provider,identity);assertCapability(context,capability);return context;
}
export function assertModel(context:AuthorizationContext, model:string) {
  if (!context.entitlements.allowedModels.includes(model)) throw new AuthorizationError('Model is not entitled');
}
export function policyFingerprint(context:AuthorizationContext) {
  return JSON.stringify({tenantId:context.tenantId,userId:context.userId,roles:[...context.roles].sort(),entitlements:context.entitlements});
}
/** Local administrative file adapter only; hosted apps supply verified IAM/billing claims. */
export function fileAuthorizationProvider(path:string|URL, identity:{tenantId:string;userId:string}):AuthorizationProvider {
  const bound={...identity};
  return async()=>{
    const bytes = await readFile(path,'utf8');
    if(bytes.length>16000)throw new AuthorizationError('Policy file is too large');
    const policy=z.object({schemaVersion:z.literal(1),roles:z.array(z.string()).max(50),entitlements:entitlementsSchema}).strict().parse(JSON.parse(bytes));
    return {...bound,roles:policy.roles,entitlements:policy.entitlements};
  };
}
