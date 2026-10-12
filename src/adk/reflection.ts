import { z } from 'zod';
import type { MemoryService } from '../service.js';
import type { MemoryIdentity } from './adapter.js';

export const proposalSchema = z.object({
  kind:z.enum(['preference','lesson']), text:z.string().trim().min(1).max(1000),
  sourceQuote:z.string().trim().min(8).max(2000),
}).strict();
export type ReflectionProposal = z.infer<typeof proposalSchema>;
const reviewKey = (id:string) => `atlas.review.${id}`;

/** Proposals are grounded in the current user message, not the model's own reply. */
export async function proposeReflection(memory: MemoryService, identity: MemoryIdentity, input: ReflectionProposal, userMessage: string) {
  const proposal = proposalSchema.parse(input);
  if (!userMessage.includes(proposal.sourceQuote)) throw new Error('Reflection quote must appear verbatim in the current user message');
  const episode = await memory.recordEpisode(identity.tenantId,{
    userId:identity.userId,type:'atlas_reflection_proposal',summary:proposal.text,payload:proposal,
  });
  return {status:'pending_review',proposalId:episode.id};
}
export async function pendingReflections(memory: MemoryService, identity: MemoryIdentity) {
  const profile = await memory.getProfile(identity.tenantId,identity.userId);
  const reviewed = new Set(profile.facts.map(f=>f.key));
  const proposals = await memory.listEpisodes(identity.tenantId,{userId:identity.userId,type:'atlas_reflection_proposal',limit:200});
  return proposals.filter(p=>!reviewed.has(reviewKey(p.id)));
}
/** Host-only API: never exposed as a model-callable tool. */
export async function reviewReflection(memory: MemoryService, identity: MemoryIdentity, proposalId:string, decision:'accepted'|'rejected') {
  if (!['accepted','rejected'].includes(decision)) throw new Error('Invalid reflection decision');
  const proposal = (await pendingReflections(memory,identity)).find(p=>p.id===proposalId);
  if (!proposal) throw new Error('Pending proposal not found for this identity (only the latest 200 are available)');
  const content = proposalSchema.parse(proposal.payload);
  await memory.setProfileFact(identity.tenantId,identity.userId,{
    key:reviewKey(proposalId),type:'json',value:{decision,...content},
  });
  return {status:decision,proposalId};
}
export function approvedReflections(facts: {key:string;value:unknown}[]) {
  return facts.flatMap(f=>{
    if (!f.key.startsWith('atlas.review.')) return [];
    const result = proposalSchema.extend({decision:z.literal('accepted')}).safeParse(f.value);
    return result.success ? [result.data] : [];
  });
}
