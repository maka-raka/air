import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {GitHubApiError,GitHubIssueHttpAdapter} from './issue-http-adapter.js';
import type {HttpRequest} from './issue-http-adapter.js';
import {GitHubDeliveryStateStore} from './delivery-state-store.js';

type Call={url:string;method:string;body?:string;auth?:string};
function fixture(initial:{status?:number;labels?:string[];state?:'open'|'closed'}={}) {
  const calls:Call[]=[];
  let status=initial.status??200;
  let labels=[...(initial.labels??['air:requirements:ready','priority:high'])];
  let state=initial.state??'open';
  const request:HttpRequest=async(url,init)=>{
    calls.push({url,method:init.method,body:init.body,auth:init.headers.Authorization});
    if(status!==200) return {ok:false,status,json:async()=>({message:'redacted'})};
    if(init.method==='PUT') labels=(JSON.parse(init.body??'{}') as {labels:string[]}).labels;
    if(init.method==='PATCH') state='closed';
    return {ok:true,status:200,json:async()=>({labels:labels.map(name=>({name})),state})};
  };
  const client=new GitHubIssueHttpAdapter({owner:'example',repo:'air',token:'test-secret',request});
  return {client,calls,labels:()=>labels,state:()=>state,setStatus:(value:number)=>{status=value;}};
}
async function expectCategory(action:()=>Promise<unknown>,category:GitHubApiError['category']) {
  await assert.rejects(action,error=>error instanceof GitHubApiError&&error.category===category);
}
describe('GitHubIssueHttpAdapter',()=>{
  it('reads labels and closed state using an authenticated endpoint',async()=>{
    // Arrange
    const {client,calls}=fixture();
    // Act
    const result=await client.read(42);
    // Assert
    assert.deepEqual(result,{labels:['air:requirements:ready','priority:high'],closed:false});
    assert.equal(calls[0].url,'https://api.github.com/repos/example/air/issues/42');
    assert.equal(calls[0].auth,'Bearer test-secret');
    assert.equal(calls[0].method,'GET');
    assert.ok(!calls[0].url.includes('test-secret'));
  });
  it('persists a delivery transition while preserving unrelated labels',async()=>{
    // Arrange
    const {client,calls,labels}=fixture();
    const store=new GitHubDeliveryStateStore(client);
    // Act
    const result=await store.apply(42,{action:'start',actor:'agent',facts:{preflightPassed:true,activeRun:false}});
    // Assert
    assert.equal(result.ok,true);
    assert.deepEqual(labels(),['priority:high','air:requirements:working']);
    assert.ok(calls.some(call=>call.method==='PUT'));
  });
  for(const [status,category] of [[401,'authentication'],[403,'forbidden'],[404,'not-found'],[429,'rate-limited'],[503,'server-error']] as const) {
    it('classifies HTTP '+status+' as '+category,async()=>{
      // Arrange
      const {client}=fixture({status});
      // Act & Assert
      await expectCategory(()=>client.read(42),category);
    });
  }
  it('marks failed write with server response as ambiguous',async()=>{
    // Arrange
    const {client}=fixture({status:503});
    // Act & Assert
    await assert.rejects(()=>client.replaceLabels(42,['test']),error=>
      error instanceof GitHubApiError&&error.category==='server-error'&&error.ambiguousWrite);
  });
  it('classifies transport failures and treats writes as ambiguous',async()=>{
    // Arrange
    const client=new GitHubIssueHttpAdapter({owner:'example',repo:'air',token:'test-secret',
      request:async()=>{throw new Error('network down');}});
    // Act & Assert
    await expectCategory(()=>client.read(1),'network-error');
    await assert.rejects(()=>client.replaceLabels(1,['test']),error=>
      error instanceof GitHubApiError&&error.category==='network-error'&&error.ambiguousWrite);
  });
  it('rejects malformed GitHub issue payloads',async()=>{
    // Arrange
    const client=new GitHubIssueHttpAdapter({owner:'example',repo:'air',token:'test-secret',
      request:async()=>({ok:true,status:200,json:async()=>({labels:[{wrong:'name'}],state:'open'})})});
    // Act & Assert
    await expectCategory(()=>client.read(1),'invalid-response');
  });
  it('rejects duplicate labels before making a write',async()=>{
    // Arrange
    const {client,calls}=fixture();
    // Act & Assert
    await assert.rejects(()=>client.replaceLabels(1,['a','a']),/Invalid label set/);
    assert.equal(calls.length,0);
  });
});
