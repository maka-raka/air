import { GitHubDeliveryStateStore, parseSnapshot } from './delivery-state-store.js';
import type { IssueLabelsPort, ReadIssue, StoreFailure } from './delivery-state-store.js';
import type { Request } from '../delivery/state-machine.js';

let checks=0;
function assert(condition:boolean,message:string) { checks++; if(!condition) throw new Error(message); }
class Fake implements IssueLabelsPort {
  issue:ReadIssue;
  reads=0;
  beforeSecondRead?:()=>void;
  writeThenThrow=false;
  closeThenThrow=false;
  afterWrite?:()=>void;
  constructor(labels:string[],closed=false) { this.issue={labels,closed}; }
  async read():Promise<ReadIssue> {
    this.reads++;
    if(this.reads===2) this.beforeSecondRead?.();
    return {labels:[...this.issue.labels],closed:this.issue.closed};
  }
  async replaceLabels(_issue:number,labels:readonly string[]) {
    this.issue={...this.issue,labels:[...labels]};
    this.afterWrite?.();
    if(this.writeThenThrow) throw new Error('connection lost after write');
  }
  async closeIssue() { if(this.closeThenThrow) throw new Error('close unavailable'); this.issue={...this.issue,closed:true}; }
}
const start:Request={action:'start',actor:'agent',facts:{preflightPassed:true,activeRun:false}};
async function success(fake:Fake,request:Request,expected:string|null) {
  const result=await new GitHubDeliveryStateStore(fake).apply(42,request);
  assert(result.ok,'expected success: '+JSON.stringify(result));
  if(expected) assert(fake.issue.labels.includes(expected),'missing expected state');
  return result;
}
async function failure(fake:Fake,request:Request,reason:StoreFailure) {
  const result=await new GitHubDeliveryStateStore(fake).apply(42,request);
  assert(!result.ok && result.reason===reason,'expected '+reason+': '+JSON.stringify(result));
}
async function main() {
  const init=new Fake(['priority:high','air:deployed:stage']);
  await success(init,{action:'initialize',actor:'human'},'air:requirements:ready');
  assert(init.issue.labels.includes('priority:high'),'unrelated label preserved');
  assert(init.issue.labels.includes('air:deployed:stage'),'deployment marker preserved');
  await success(init,start,'air:requirements:working');
  assert(!init.issue.labels.includes('air:requirements:ready'),'old state removed');
  await failure(init,start,'invalid-transition');
  await failure(new Fake(['priority:high']),start,'invalid-state');
  await failure(new Fake(['air:requirements:ready','air:build:ready']),start,'invalid-state');
  await failure(new Fake(['air:requirements:unknown']),start,'invalid-state');
  await failure(new Fake(['air:requirements:ready','air:requirements:ready']),start,'invalid-state');
  await failure(new Fake(['air:requirements:ready'],true),start,'invalid-state');
  const conflict=new Fake(['air:requirements:ready']);
  conflict.beforeSecondRead=()=>{conflict.issue={labels:['air:requirements:blocked'],closed:false};};
  await failure(conflict,start,'state-conflict');
  assert(conflict.issue.labels.includes('air:requirements:blocked'),'conflict must not overwrite');
  const unrelatedConflict=new Fake(['air:requirements:ready','priority:low']);
  unrelatedConflict.beforeSecondRead=()=>{unrelatedConflict.issue={labels:['air:requirements:ready','priority:high'],closed:false};};
  await failure(unrelatedConflict,start,'state-conflict');
  const ambiguous=new Fake(['air:requirements:ready']);
  ambiguous.writeThenThrow=true;
  await failure(ambiguous,start,'uncertain-write');
  assert(ambiguous.issue.labels.includes('air:requirements:working'),'ambiguous write can have succeeded');
  const mismatch=new Fake(['air:requirements:ready']);
  mismatch.afterWrite=()=>{mismatch.issue={labels:['air:requirements:blocked'],closed:false};};
  await failure(mismatch,start,'uncertain-write');
  const concurrent=new Fake(['air:requirements:ready','priority:low']);
  concurrent.afterWrite=()=>{concurrent.issue={labels:['air:requirements:working','priority:high'],closed:false};};
  await failure(concurrent,start,'state-conflict');
  const close=new Fake(['air:observe:waiting','air:deployed:prod']);
  await success(close,{action:'close',actor:'human',facts:{observeGo:true}},null);
  assert(close.issue.closed,'issue must close');
  assert(!close.issue.labels.includes('air:observe:waiting'),'terminal label must be removed');
  const partial=new Fake(['air:observe:waiting','priority:high']);
  partial.closeThenThrow=true;
  await failure(partial,{action:'close',actor:'human',facts:{observeGo:true}},'partial-completion');
  assert(!partial.issue.closed,'failed close leaves issue open');
  assert(!partial.issue.labels.includes('air:observe:waiting'),'partial close removes active label');
  assert(partial.issue.labels.includes('priority:high'),'partial close preserves unrelated labels');
  await failure(close,{action:'initialize',actor:'human'},'invalid-transition');
  assert(parseSnapshot({labels:['air:deployed:prod'],closed:false}).position===null,'deployment marker is not active');
  console.log('GitHub DeliveryStateStore passed: '+checks+' assertions');
}
await main();
