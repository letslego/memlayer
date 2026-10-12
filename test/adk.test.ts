import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemlayerAdapter, runAdkAnswer } from '../src/adk/adapter.js';
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import { openMemoryService } from '../src/service.js';
import { testMemory } from './helpers.js';

class RecallModel extends BaseLlm {
  constructor() { super({model:'offline-test'}); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    const response = request.contents.flatMap(c=>c.parts??[]).find(p=>p.functionResponse);
    if (!response) yield {content:{role:'model',parts:[{functionCall:{id:'recall-1',name:'recall_memory',args:{query:'Princeton',topK:5}}}]}};
    else {
      if (!JSON.stringify(response).includes('Princeton')) throw new Error('Expected retrieved evidence');
      yield {content:{role:'model',parts:[{text:'Princeton'}]},turnComplete:true};
    }
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('Live connections unused'); }
}

describe('ADK memory adapter',()=>{
  it('runs the real ADK tool loop, persists chat and leaves evaluation read-only',async()=>{
    const memory = await testMemory();
    try {
      const adapter = new MemlayerAdapter(memory,{tenantId:'one',userId:'a'});
      await adapter.saveExchange('old','I live in Princeton.','Thanks.');
      const answer = await runAdkAnswer({question:'Where do I live?',adapter,model:new RecallModel(),persistSession:'new'});
      expect(answer).toBe('Princeton');
      expect((await memory.getWorkingMemory('one',adapter.sessionKey('new'))).turns).toHaveLength(2);
      const before = (await memory.listEpisodes('one',{userId:'a'})).length;
      expect(await runAdkAnswer({question:'Where do I live?',adapter,model:new RecallModel()})).toBe('Princeton');
      expect((await memory.listEpisodes('one',{userId:'a'})).length).toBe(before);
    } finally {await memory.close();}
  });
  it('isolates tenants, users and equal session names',async()=>{
    const memory = await testMemory();
    try {
      const a = new MemlayerAdapter(memory,{tenantId:'one',userId:'a'});
      const b = new MemlayerAdapter(memory,{tenantId:'one',userId:'b'});
      const c = new MemlayerAdapter(memory,{tenantId:'two',userId:'a'});
      await a.saveExchange('session','My favorite gemstone is sapphire.','Remembered.');
      await a.rememberFact('city','Princeton');
      expect((await a.recall('favorite gemstone sapphire')).length).toBeGreaterThan(0);
      expect(await b.recall('favorite gemstone sapphire')).toEqual([]);
      expect(await c.recall('favorite gemstone sapphire')).toEqual([]);
      expect((await b.profile()).facts).toEqual([]);
      expect((await memory.getWorkingMemory('one',b.sessionKey('session'))).turns).toEqual([]);
      expect(a.tools(true).map(t=>t.name)).not.toContain('remember_fact');
      expect(a.sessionKey('session')).not.toBe(b.sessionKey('session'));
    } finally {await memory.close();}
  });
  it('restores profile, episodes and retrieval after reopening',async()=>{
    const dir = await mkdtemp(join(tmpdir(),'memlayer-adk-'));
    let memory = await openMemoryService({databasePath:join(dir,'memory.sqlite')});
    try {
      const identity = {tenantId:'one',userId:'a'};
      const a = new MemlayerAdapter(memory,identity);
      await a.saveExchange('old','I live in Princeton.','Thanks.');
      await a.rememberFact('city','Princeton');
      await memory.close();
      memory = await openMemoryService({databasePath:join(dir,'memory.sqlite')});
      const restored = new MemlayerAdapter(memory,identity);
      expect((await restored.recall('Princeton')).length).toBeGreaterThan(0);
      expect((await restored.profile()).facts[0]!.value).toBe('Princeton');
      expect(await memory.listEpisodes('one',{userId:'a'})).toHaveLength(1);
    } finally {await memory.close();await rm(dir,{recursive:true,force:true});}
  });
});
