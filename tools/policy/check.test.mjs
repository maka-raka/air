import {checkScriptNames} from './check.mjs';
import assert from 'node:assert/strict';
assert.deepEqual(checkScriptNames({'architecture:check':'x','policy:check':'y'}),[]);
assert.equal(checkScriptNames({'check:architecture':'x'}).length,0); // syntactically ambiguous: semantic validation needs registry
assert.equal(checkScriptNames({'CheckArchitecture':'x'}).length,1);
assert.equal(checkScriptNames({'domain:test':'x'}).length,0);
console.log('Policy naming validator passed');
