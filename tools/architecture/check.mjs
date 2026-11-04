import {readFileSync,readdirSync} from 'node:fs';
import {resolve,relative,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const normalize=p=>p.replaceAll('\\','/');
const matches=(path,pattern)=>pattern.endsWith('/**')?path.startsWith(pattern.slice(0,-3)+'/'):path===pattern;
export function owner(path,model) {
  const matchesFound=model.components.filter(c=>c.paths.some(p=>matches(path,p)));
  if(matchesFound.length!==1) throw new Error('Expected exactly one component owner for '+path+', found '+matchesFound.length);
  return matchesFound[0];
}
export function verifyDependency(source,target,model) {
  const from=owner(source,model),to=owner(target,model);
  if(from.id!==to.id&&!from.dependencies.includes(to.id))
    throw new Error('Forbidden dependency '+from.id+' -> '+to.id+': '+source+' -> '+target);
}
function files(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const path=resolve(dir,entry.name);
    return entry.isDirectory()?files(path):entry.isFile()&&/\.tsx?$/.test(entry.name)?[path]:[];
  });
}
function imports(content) {
  const found=[];
  const re=/(?:\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  for(const match of content.matchAll(re)) found.push(match[1]);
  return found;
}
export function check() {
  const model=JSON.parse(readFileSync(resolve(root,'architecture/model.json'),'utf8'));
  if(model.schemaVersion!==1||!Array.isArray(model.components)) throw new Error('Invalid architecture model');
  const ids=new Set();
  for(const c of model.components) {
    if(ids.has(c.id)||!Array.isArray(c.paths)||!Array.isArray(c.dependencies)) throw new Error('Invalid component');
    ids.add(c.id);
  }
  for(const c of model.components) for(const dep of c.dependencies) if(!ids.has(dep)) throw new Error('Unknown dependency '+dep);
  const violations=[];
  const sourceFiles=files(resolve(root,'src')).filter(f=>!f.endsWith('.test.ts'));
  for(const absolute of sourceFiles) {
    const source=normalize(relative(root,absolute));
    try {owner(source,model);} catch(error) {violations.push(String(error));continue;}
    for(const specifier of imports(readFileSync(absolute,'utf8'))) {
      if(!specifier.startsWith('.')) continue;
      const resolved=resolve(dirname(absolute),specifier);
      const target=normalize(relative(root,resolved.replace(/\.js$/i,'.ts')));
      if(!target.startsWith('src/')) {violations.push('Relative import outside src: '+source+' -> '+specifier);continue;}
      try {verifyDependency(source,target,model);} catch(error) {violations.push(String(error));}
    }
  }
  const report={ruleId:'architecture.c4-conformance',passed:violations.length===0,filesChecked:sourceFiles.length,violations};
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(!report.passed) process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) check();
