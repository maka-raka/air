import assert from 'node:assert/strict';
import {owner,verifyDependency} from './check.mjs';
const model={components:[
  {id:'domain',paths:['src/domain/**'],dependencies:[]},
  {id:'application',paths:['src/application/**'],dependencies:['domain']},
  {id:'adapter',paths:['src/adapters/**'],dependencies:['application']}
]};
assert.equal(owner('src/domain/entity.ts',model).id,'domain');
assert.throws(()=>owner('src/unmapped/rogue.ts',model),/exactly one/);
assert.throws(()=>verifyDependency('src/domain/entity.ts','src/adapters/db.ts',model),/Forbidden/);
assert.doesNotThrow(()=>verifyDependency('src/application/use-case.ts','src/domain/entity.ts',model));
assert.throws(()=>owner('src/domain/entity.ts',{components:[...model.components,{id:'duplicate',paths:['src/domain/**'],dependencies:[]}]}),/exactly one/);
console.log('Architecture conformance negative fixtures passed');
