import { describe, expect, it } from 'vitest';
import { answerScore, evidenceHits, evidenceIds, ingestSample, parseLocomo, retrieve, scoreEvidence } from '../src/bench/locomo.js';
import { testMemory } from './helpers.js';
import type { KnowledgeHit } from '../src/types.js';

const fixture = [{ sample_id: 'fixture', conversation: {
  session_1_date_time: '8 May 2023', session_1: [
    { dia_id:'D1:1',speaker:'Ada',text:'My favorite gemstone is sapphire.' },
    { dia_id:'D1:2',speaker:'Ben',text:'I bought a bicycle.' },
  ], session_2_date_time: '9 May 2023', session_2: [{ dia_id:'D2:1',speaker:'Ada',text:'I live in Princeton.' }],
}, qa:[{ question:'What is Ada’s favorite gemstone?',answer:'sapphire',category:4,evidence:['D1:1'] }] }];
describe('LoCoMo evaluation',()=>{
  it('scores multiple evidence IDs, empty results, duplicates and rank correctly',()=>{
    expect(scoreEvidence(['x','D1:1','D1:1','D2:1'],['D1:1','D2:1'])).toEqual({recall1:0,recall5:1,recall10:1,precision10:0.2,mrr:0.5});
    expect(scoreEvidence([],['D1:1']).recall10).toBe(0);
    expect(()=>scoreEvidence([],[])).toThrow();
    expect(evidenceIds(['D8:6; D9:17','D:11:26','D30:05','D'])).toEqual(['D8:6','D9:17','D11:26','D30:5','D']);
  });
  it('retains session metadata, rejects duplicates and does not index answers',async()=>{
    const [sample] = parseLocomo(fixture);
    expect(sample!.turns[2]!.session).toBe('session_2');
    expect(()=>parseLocomo([...fixture,...fixture])).toThrow('Duplicate sample');
    const memory = await testMemory({hnswSeed:42});
    try {
      await ingestSample(memory,sample!);
      for(const mode of ['hybrid','bm25','vector'] as const) {
        const hits = await retrieve(memory,sample!.id,'favorite gemstone sapphire',mode);
        expect(hits[0]!.source).toBe('D1:1');
        expect(hits[0]!.text).toContain('8 May 2023');
        expect(hits[0]!.text).not.toContain(sample!.qa[0]!.question);
      }
      expect(await retrieve(memory,'other','sapphire','hybrid')).toEqual([]);
    } finally {await memory.close();}
  });
  it('deduplicates chunks before evidence ranking and uses multiset answer overlap',()=>{
    const hit = {source:'D1:1'} as KnowledgeHit;
    expect(evidenceHits([hit,hit])).toHaveLength(1);
    expect(answerScore('the red red car','red car')).toEqual({exactMatch:0,tokenF1:0.8});
  });
});
