import { GitHubApiError, GitHubIssuesHttpAdapter } from './issues-http-adapter.js';
import type { HttpRequest } from './issues-http-adapter.js';
import { GitHubDeliveryStateStore } from './delivery-state-store.js';

let assertions=0;
function check(ok:boolean,why:string):void { assertions++; if(!ok) throw new Error(why); }
const calls:{url:string;method:string;body?:string;auth?:string}[]=[];
let status=200;
let labels=['air:requirements:ready','priority:high'];
let state='open';
const request:HttpRequest=async (url,init)=>{
  calls.push({url,method:init.method,body:init.body,auth:init.headers.Authorization});
  if(status!==200) return {ok:false,status,json:async()=>({message:'redacted'})};
  if(init.method==='PUT') labels=(JSON.parse(init.body??'{}') as {labels:string[]}).labels;
  if(init.method==='PATCH') state='closed';
  return {ok:true,status:200,json:async()=>({labels:labels.map(name=>({name})),state})};
};
const client=new GitHubIssuesHttpAdapter({owner:'maka-raka',repo:'air',token:'test-secret',request});
async function error(expected:string,action:()=>Promise<unknown>):Promise<void> {
  try { await action(); throw new Error('Expected '+expected); }
  catch(e) {
    check(e instanceof GitHubApiError && e.category===expected,'Expected '+expected+' got '+String(e));
  }
}
async function main() {
  const first=await client.read(42);
  check(first.labels.length===2 && !first.closed,'read labels and state');
  check(calls[0].url==='https://api.github.com/repos/maka-raka/air/issues/42','correct endpoint');
  check(calls[0].auth==='Bearer test-secret','authenticated request');
  const store=new GitHubDeliveryStateStore(client);
  const started=await store.apply(42,{action:'start',actor:'agent',facts:{preflightPassed:true,activeRun:false}});
  check(started.ok,'end-to-end transition with mocked HTTP');
  check(labels.includes('air:requirements:working') && labels.includes('priority:high'),'labels preserved');
  check(calls.some(call=>call.method==='PUT'),'labels written via PUT');
  status=401;await error('authentication',()=>client.read(42));
  status=403;await error('forbidden',()=>client.read(42));
  status=404;await error('not-found',()=>client.read(42));
  status=429;await error('rate-limited',()=>client.read(42));
  status=503;await error('server-error',()=>client.read(42));
  await error('server-error',()=>client.replaceLabels(42,['test']));
  status=200;
  const transport=new GitHubIssuesHttpAdapter({owner:'x',repo:'y',token:'token',
    request:async()=>{throw new Error('network down');}});
  await error('network-error',()=>transport.read(1));
  try { await transport.replaceLabels(1,['test']);throw new Error('Expected ambiguous mutation'); }
  catch(e) { check(e instanceof GitHubApiError && e.ambiguousWrite,'network write is ambiguous'); }
  const malformed=new GitHubIssuesHttpAdapter({owner:'x',repo:'y',token:'token',
    request:async()=>({ok:true,status:200,json:async()=>({labels:[{wrong:'name'}],state:'open'})})});
  await error('invalid-response',()=>malformed.read(1));
  check(!calls.some(call=>call.url.includes('test-secret')),'token never in URL');
  console.log('GitHub Issues HTTP adapter passed: '+assertions+' assertions');
}
await main();
