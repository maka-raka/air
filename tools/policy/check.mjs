import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function checkScriptNames(scripts) {
  const violations=[];
  const legacy=new Set(['build','test','typecheck']);
  const actions=new Set(['check','test','build','fix','watch','run','lint','generate']);
  for(const key of Object.keys(scripts)) {
    if(legacy.has(key)) continue;
    if(!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(key) || !actions.has(key.split(':')[1]))
      violations.push({ruleId:'scripts.naming',message:'Expected entity:action',script:key});
  }
  return violations;
}
export function check() {
  const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
  const violations=checkScriptNames(pkg.scripts);
  const report={policy:'air/engineering-baseline',passed:violations.length===0,violations};
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(!report.passed) process.exitCode=1;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) check();
