import { StatusCodes } from 'http-status-codes';
import type { IssueLabelsPort, ReadIssue } from './delivery-state-store.js';

export type HttpResponse = {
  readonly ok:boolean;
  readonly status:number;
  json():Promise<unknown>;
};
export type HttpRequest = (url:string, init:{
  method:string;
  headers:Record<string,string>;
  body?:string;
  signal?:AbortSignal;
})=>Promise<HttpResponse>;
export type GitHubIssueClientOptions = {
  owner:string;
  repo:string;
  token:string;
  request?:HttpRequest;
  baseUrl?:string;
  timeoutMs?:number;
};
export type GitHubApiErrorCategory =
  | 'authentication'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'server-error'
  | 'client-error'
  | 'network-error'
  | 'invalid-response';

export class GitHubApiError extends Error {
  constructor(
    readonly status:number | null,
    readonly category: GitHubApiErrorCategory,
    message:string,
    readonly ambiguousWrite:boolean=false,
  ) { super(message); this.name='GitHubApiError'; }
}
function object(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==='object' && !Array.isArray(value);
}
function validateName(value:string,name:string):string {
  if(!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid '+name);
  return value;
}
function validateIssue(issue:number):number {
  if(!Number.isSafeInteger(issue)||issue<1) throw new Error('Invalid issue number');
  return issue;
}
function classify(status:number,write:boolean):GitHubApiError {
  const category = status===StatusCodes.UNAUTHORIZED?'authentication':status===StatusCodes.FORBIDDEN?'forbidden':
    status===StatusCodes.NOT_FOUND?'not-found':status===StatusCodes.TOO_MANY_REQUESTS?'rate-limited':
    status>=StatusCodes.INTERNAL_SERVER_ERROR?'server-error':'client-error';
  return new GitHubApiError(status,category,'GitHub API request failed ('+status+')',
    write && (status===StatusCodes.TOO_MANY_REQUESTS || status>=StatusCodes.INTERNAL_SERVER_ERROR));
}
/**
 * Infrastructure-only GitHub REST adapter. Token must be supplied by a trusted
 * caller; do not pass user-provided role claims as authentication.
 * No automatic retries for mutations: GitHub labels have no CAS.
 */
export class GitHubIssueHttpAdapter implements IssueLabelsPort {
  private readonly endpoint:string;
  private readonly request:HttpRequest;
  private readonly token:string;
  private readonly timeoutMs:number;
  constructor(options:GitHubIssueClientOptions) {
    this.endpoint=(options.baseUrl??'https://api.github.com').replace(/\/$/,'')+
      '/repos/'+validateName(options.owner,'owner')+'/'+validateName(options.repo,'repo')+'/issues/';
    if(!options.token.trim()) throw new Error('GitHub token is required');
    this.token=options.token;
    this.request=options.request??((url,init)=>fetch(url,init));
    this.timeoutMs=options.timeoutMs??15000;
    if(!Number.isFinite(this.timeoutMs)||this.timeoutMs<=0) throw new Error('Invalid timeout');
  }
  private async call(issue:number,method:'GET'|'PUT'|'PATCH',suffix:string,body?:unknown):Promise<unknown> {
    const write=method!=='GET';
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),this.timeoutMs);
    let response:HttpResponse;
    try {
      response=await this.request(this.endpoint+validateIssue(issue)+suffix,{
        method,signal:controller.signal,
        headers:{
          'Accept':'application/vnd.github+json',
          'Authorization':'Bearer '+this.token,
          'X-GitHub-Api-Version':'2022-11-28',
          ...(write?{'Content-Type':'application/json'}:{}),
        },
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
    } catch(error) {
      throw new GitHubApiError(null,'network-error','GitHub API transport failure: '+String(error),write);
    } finally { clearTimeout(timeout); }
    if(!response.ok) throw classify(response.status,write);
    try { return await response.json(); }
    catch(error) {
      throw new GitHubApiError(response.status,'invalid-response','GitHub API response is not JSON: '+String(error),write);
    }
  }
  async read(issue:number):Promise<ReadIssue> {
    const data=await this.call(issue,'GET','');
    if(!object(data)||!Array.isArray(data.labels)||
      typeof data.state!=='string'||!['open','closed'].includes(data.state))
      throw new GitHubApiError(200,'invalid-response','Invalid GitHub Issue payload');
    const labels=data.labels.map((label:unknown)=>{
      if(!object(label)||typeof label.name!=='string')
        throw new GitHubApiError(200,'invalid-response','Invalid GitHub label payload');
      return label.name;
    });
    return {labels,closed:data.state==='closed'};
  }
  async replaceLabels(issue:number,labels:readonly string[]):Promise<void> {
    if(labels.some(label=>typeof label!=='string')||new Set(labels).size!==labels.length)
      throw new Error('Invalid label set');
    await this.call(issue,'PUT','/labels',{labels:[...labels]});
  }
  async closeIssue(issue:number):Promise<void> {
    await this.call(issue,'PATCH','',{state:'closed'});
  }
}
