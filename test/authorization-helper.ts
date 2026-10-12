import { MemlayerAdapter } from '../src/adk/adapter.js';
import type { MemoryIdentity } from '../src/adk/adapter.js';
import type { MemoryService } from '../src/service.js';
import type { EvaluationMode } from '../src/knowledge/rerank.js';
import type { AuthorizationProvider } from '../src/adk/authorization.js';

export function testAuthorization(identity:MemoryIdentity={tenantId:'one',userId:'a'}):AuthorizationProvider {
  return async()=>({...identity,roles:[],entitlements:{
    capabilities:['recall_memory','get_profile','remember_fact','propose_lesson','persist_chat','review_lessons'],canWrite:true,
    allowedModels:['gemini-2.5-flash','offline-test','persona-offline-test'],allowedPersonaRoles:['engineering_partner','analyst','tutor'],maxContextChars:24000,
  }});
}
export class TestAdapter extends MemlayerAdapter {
  constructor(memory:MemoryService, identity:MemoryIdentity,mode:EvaluationMode='hybrid') {super(memory,identity,mode,testAuthorization(identity));}
}
