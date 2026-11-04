/** Pure Delivery transition policy. Authentication and evidence acquisition belong to adapters. */
export type Phase = 'requirements' | 'design' | 'build' | 'review' | 'accept' | 'observe';
export type Status = 'ready' | 'working' | 'blocked' | 'waiting';
export type Actor = 'human' | 'agent' | 'gate' | 'deployment-workflow';
export type Position = Readonly<{phase: Phase; status: Status}>;
export type Gate = Readonly<{passed: boolean; problems: readonly string[]; evidenceRevision: string; expectedRevision: string; verdict?: 'go' | 'no-go'}>;
export type Facts = Readonly<{
  preflightPassed?: boolean; activeRun?: boolean; reportRecorded?: boolean;
  feedbackRecorded?: boolean; recoveryConfirmed?: boolean; taskSize?: 'S' | 'L';
  miniDesignRecorded?: boolean; designApproved?: boolean; prExists?: boolean;
  checksGreen?: boolean; approvedMergedPr?: boolean; deploymentVerified?: boolean;
  changeIncluded?: boolean; observeGo?: boolean;
}>;
export type Action = 'initialize' | 'start' | 'complete' | 'block' | 'retry' | 'rework' | 'advance' | 'deploy-stage' | 'deploy-prod' | 'close' | 'recover';
export type Request = Readonly<{action: Action; actor: Actor; target?: Phase; gate?: Gate; facts?: Facts}>;
export type Decision = {allowed: true; next: Position | null} | {allowed: false; reason: 'not-authorized' | 'invalid-transition' | 'gate-rejected' | 'precondition-failed'};
const position = (phase: Phase, status: Status): Position => ({phase, status});
const denied = (reason: Extract<Decision,{allowed:false}>['reason']): Decision => ({allowed:false,reason});
const allowed = (next: Position | null): Decision => ({allowed:true,next});
export function decideTransition(current: Position | null, request: Request): Decision {
  const f = request.facts ?? {};
  const {action,actor} = request;
  const roles: Record<Action,Actor> = {
    initialize:'human',start:'agent',complete:'gate',block:'agent',
    retry:'human',rework:'human',advance:'human',
    'deploy-stage':'deployment-workflow','deploy-prod':'deployment-workflow',
    close:'human',recover:'human'
  };
  if (actor !== roles[action]) return denied('not-authorized');
  if (action === 'initialize') return current === null ? allowed(position('requirements','ready')) : denied('invalid-transition');
  if (!current) return denied('invalid-transition');
  const {phase,status} = current;
  switch (action) {
    case 'start':
      if (status !== 'ready') break;
      return f.preflightPassed && f.activeRun === false ? allowed(position(phase,'working')) : denied('precondition-failed');
    case 'complete': {
      if (status !== 'working') break;
      const g = request.gate;
      return g && g.passed && g.problems.length === 0 && !!g.evidenceRevision &&
        g.evidenceRevision === g.expectedRevision && g.verdict !== 'no-go'
        ? allowed(position(phase,'waiting')) : denied('gate-rejected');
    }
    case 'block':
      if (status !== 'working') break;
      return f.reportRecorded ? allowed(position(phase,'blocked')) : denied('precondition-failed');
    case 'retry':
      if (status !== 'blocked') break;
      return f.feedbackRecorded ? allowed(position(phase,'ready')) : denied('precondition-failed');
    case 'rework':
      if (status !== 'waiting') break;
      return f.feedbackRecorded ? allowed(position(phase,'ready')) : denied('precondition-failed');
    case 'recover':
      if (status !== 'working') break;
      return f.recoveryConfirmed && f.reportRecorded && f.activeRun === false
        ? allowed(position(phase,'ready')) : denied('precondition-failed');
    case 'advance': {
      if (status !== 'waiting') break;
      const to = request.target;
      const valid = (phase === 'requirements' && ((to === 'design' && f.taskSize === 'L') ||
        (to === 'build' && f.taskSize === 'S' && f.miniDesignRecorded))) ||
        (phase === 'design' && to === 'build' && f.designApproved) ||
        (phase === 'build' && to === 'review' && f.prExists && f.checksGreen);
      return valid && to ? allowed(position(to,'ready')) : denied('precondition-failed');
    }
    case 'deploy-stage':
      if (phase !== 'review' || status !== 'waiting') break;
      return f.approvedMergedPr && f.deploymentVerified && f.changeIncluded
        ? allowed(position('accept','ready')) : denied('precondition-failed');
    case 'deploy-prod':
      if (phase !== 'accept' || status !== 'waiting') break;
      return f.deploymentVerified && f.changeIncluded
        ? allowed(position('observe','ready')) : denied('precondition-failed');
    case 'close':
      if (phase !== 'observe' || status !== 'waiting') break;
      return f.observeGo ? allowed(null) : denied('precondition-failed');
  }
  return denied('invalid-transition');
}
