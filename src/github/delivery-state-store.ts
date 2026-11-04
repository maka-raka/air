import { decideTransition } from '../delivery/state-machine.js';
import type { Decision, Phase, Position, Request, Status } from '../delivery/state-machine.js';

const phases: readonly string[] = ['requirements','design','build','review','accept','observe'];
const statuses: readonly string[] = ['ready','working','blocked','waiting'];
const activePattern = /^air:([^:]+):([^:]+)$/;
export type Snapshot = Readonly<{labels: readonly string[]; position: Position | null; closed: boolean}>;
export type ReadIssue = Readonly<{labels: readonly string[]; closed: boolean}>;
export interface IssueLabelsPort {
  read(issue: number): Promise<ReadIssue>;
  replaceLabels(issue: number, labels: readonly string[]): Promise<void>;
  closeIssue(issue: number): Promise<void>;
}
export type StoreFailure = 'invalid-state'|'state-conflict'|'invalid-transition'|'not-authorized'|
  'gate-rejected'|'precondition-failed'|'write-failed'|'uncertain-write'|'partial-completion';
export type StoreResult =
  | {ok:true; snapshot:Snapshot; replayed?:boolean}
  | {ok:false; reason:StoreFailure; detail?:string};

const fail = (reason:StoreFailure,detail?:string):StoreResult=>({ok:false,reason,detail});
const stateLabel = (p:Position)=>`air:${p.phase}:${p.status}`;
function activeLabels(labels:readonly string[]):string[] {
  return labels.filter(label => {
    const match=activePattern.exec(label);
    return !!match && phases.includes(match[1]) && statuses.includes(match[2]);
  });
}
export function parseSnapshot(issue:ReadIssue): Snapshot {
  const active=activeLabels(issue.labels);
  const malformed=issue.labels.filter(label =>
    label.startsWith('air:') && !label.startsWith('air:deployed:') &&
    !label.startsWith('air:plan:') && !label.startsWith('air:incident:') &&
    activePattern.test(label) && !active.includes(label));
  if(active.length>1 || malformed.length>0 || new Set(issue.labels).size!==issue.labels.length)
    throw new Error('invalid-state');
  if(issue.closed && active.length>0) throw new Error('invalid-state');
  const match=active[0] ? activePattern.exec(active[0]) : null;
  return {labels:[...issue.labels],position:match ? {phase:match[1] as Phase,status:match[2] as Status}:null,closed:issue.closed};
}
function equal(a:readonly string[],b:readonly string[]):boolean {
  return a.length===b.length && a.every((value,i)=>value===b[i]);
}
function same(a:ReadIssue,b:ReadIssue):boolean {
  return a.closed===b.closed && equal([...a.labels].sort(),[...b.labels].sort());
}
function matches(a:Snapshot,b:Snapshot):boolean {
  return a.closed===b.closed && JSON.stringify(a.position)===JSON.stringify(b.position);
}
/**
 * GitHub Issues labels have no compare-and-swap. This is best-effort conflict
 * detection, not a distributed lock or an exactly-once write guarantee.
 * Never automatically retry ambiguous writes.
 */
export class GitHubDeliveryStateStore {
  constructor(private readonly port:IssueLabelsPort) {}
  async load(issue:number):Promise<StoreResult> {
    try {
      const snapshot=parseSnapshot(await this.port.read(issue));
      return snapshot.position===null && !snapshot.closed
        ? fail('invalid-state','Missing active label; initialize explicitly')
        : {ok:true,snapshot};
    } catch(e) { return fail('invalid-state',String(e)); }
  }
  async apply(issue:number,request:Request):Promise<StoreResult> {
    let first:ReadIssue;
    let before:Snapshot;
    try {
      first=await this.port.read(issue);
      before=parseSnapshot(first);
    } catch(e) { return fail('invalid-state',String(e)); }
    if(before.closed) return fail('invalid-transition','Issue is closed');
    if(before.position===null && request.action!=='initialize')
      return fail('invalid-state','Missing active state');
    const decision:Decision=decideTransition(before.position,request);
    if(!decision.allowed) return fail(decision.reason);
    const next=decision.next;
    let latest:ReadIssue;
    try { latest=await this.port.read(issue); }
    catch(e) { return fail('state-conflict','Unable to confirm unchanged state: '+String(e)); }
    if(!same(first,latest)) return fail('state-conflict','Issue changed before write');
    const labels=next
      ? [...first.labels.filter(label=>!activeLabels([label]).length),stateLabel(next)]
      : [...first.labels];
    try {
      if(next) await this.port.replaceLabels(issue,labels);
      else await this.port.closeIssue(issue);
    } catch(e) {
      // A transport failure may occur after GitHub accepted the write.
      return fail('uncertain-write',String(e));
    }
    let after:Snapshot;
    try { after=parseSnapshot(await this.port.read(issue)); }
    catch(e) { return fail('uncertain-write','Cannot verify write: '+String(e)); }
    const expected:Snapshot={labels,position:next,closed:next===null};
    if(!matches(after,expected)) return fail('uncertain-write','Read-back state mismatch');
    if(next && !equal([...after.labels].sort(),[...labels].sort()))
      return fail('state-conflict','Concurrent label modification detected after write');
    return {ok:true,snapshot:after};
  }
}
