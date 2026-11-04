import { decideTransition } from './state-machine.js';
import type { Action, Actor, Facts, Gate, Phase, Position, Request, Status } from './state-machine.js';

const phases: readonly Phase[] = ['requirements','design','build','review','accept','observe'];
const statuses: readonly Status[] = ['ready','working','blocked','waiting'];
const actors: readonly Actor[] = ['human','agent','gate','deployment-workflow'];
const at = (phase: Phase,status: Status): Position => ({phase,status});
const facts: Facts = {preflightPassed:true,activeRun:false,reportRecorded:true,feedbackRecorded:true,
  recoveryConfirmed:true,taskSize:'L',miniDesignRecorded:true,designApproved:true,prExists:true,
  checksGreen:true,approvedMergedPr:true,deploymentVerified:true,changeIncluded:true,observeGo:true};
const gate: Gate = {passed:true,problems:[],evidenceRevision:'head-123',expectedRevision:'head-123',verdict:'go'};
let assertions=0;
function expect(actual: unknown,expected: unknown,description: string): void {
  assertions++;
  if(JSON.stringify(actual)!==JSON.stringify(expected))
    throw new Error(description+' expected '+JSON.stringify(expected)+' got '+JSON.stringify(actual));
}
function run(current: Position|null,action: Action,actor: Actor,overrides: Partial<Request>={}) {
  return decideTransition(current,{action,actor,facts,gate,...overrides});
}
function next(current: Position|null,action: Action,actor: Actor,target: Position|null,overrides: Partial<Request>={}) {
  expect(run(current,action,actor,overrides),{allowed:true,next:target},action+' transition');
}
function rejected(current: Position|null,action: Action,actor: Actor,reason: string,overrides: Partial<Request>={}) {
  expect(run(current,action,actor,overrides),{allowed:false,reason},action+' rejected');
}

// T00–T13: every documented successful transition.
next(null,'initialize','human',at('requirements','ready'));
for(const phase of phases) {
  next(at(phase,'ready'),'start','agent',at(phase,'working'));
  next(at(phase,'working'),'complete','gate',at(phase,'waiting'));
  next(at(phase,'working'),'block','agent',at(phase,'blocked'));
  next(at(phase,'blocked'),'retry','human',at(phase,'ready'));
  next(at(phase,'waiting'),'rework','human',at(phase,'ready'));
  next(at(phase,'working'),'recover','human',at(phase,'ready'));
}
next(at('requirements','waiting'),'advance','human',at('design','ready'),{target:'design'});
next(at('requirements','waiting'),'advance','human',at('build','ready'),{target:'build',facts:{...facts,taskSize:'S'}});
next(at('design','waiting'),'advance','human',at('build','ready'),{target:'build'});
next(at('build','waiting'),'advance','human',at('review','ready'),{target:'review'});
next(at('review','waiting'),'deploy-stage','deployment-workflow',at('accept','ready'));
next(at('accept','waiting'),'deploy-prod','deployment-workflow',at('observe','ready'));
next(at('observe','waiting'),'close','human',null);

// Actor matrix: no actor can impersonate another role.
const authority: Record<Action,Actor> = {initialize:'human',start:'agent',complete:'gate',block:'agent',
  retry:'human',rework:'human',advance:'human','deploy-stage':'deployment-workflow',
  'deploy-prod':'deployment-workflow',close:'human',recover:'human'};
const actions=Object.keys(authority) as Action[];
for(const action of actions) for(const actor of actors) if(actor!==authority[action])
  rejected(at('requirements','ready'),action,actor,'not-authorized');

// Every action in every incompatible status/phase fails closed.
for(const phase of phases) for(const status of statuses) {
  const p=at(phase,status);
  for(const action of actions) {
    const result=run(p,action,authority[action],{target:'build'});
    const possible=(action==='start'&&status==='ready')||
      (action==='complete'&&status==='working')||
      (action==='block'&&status==='working')||
      (action==='retry'&&status==='blocked')||
      (action==='rework'&&status==='waiting')||
      (action==='recover'&&status==='working')||
      (action==='advance'&&status==='waiting'&&phase==='requirements')||
      (action==='deploy-stage'&&status==='waiting'&&phase==='review')||
      (action==='deploy-prod'&&status==='waiting'&&phase==='accept')||
      (action==='close'&&status==='waiting'&&phase==='observe');
    if(!possible) expect(result.allowed,false,action+' must reject '+phase+':'+status);
  }
  rejected(p,'initialize','human','invalid-transition');
}
for(const action of actions.filter(a=>a!=='initialize'))
  rejected(null,action,authority[action],'invalid-transition');

// Task classification, mini-design and design approval.
rejected(at('requirements','waiting'),'advance','human','precondition-failed',{target:'build'});
rejected(at('requirements','waiting'),'advance','human','precondition-failed',{target:'build',facts:{...facts,taskSize:'S',miniDesignRecorded:false}});
rejected(at('requirements','waiting'),'advance','human','precondition-failed',{target:'design',facts:{...facts,taskSize:'S'}});
rejected(at('design','waiting'),'advance','human','precondition-failed',{target:'build',facts:{...facts,designApproved:false}});
rejected(at('build','waiting'),'advance','human','precondition-failed',{target:'review',facts:{...facts,checksGreen:false}});
rejected(at('build','waiting'),'advance','human','precondition-failed',{target:'review',facts:{...facts,prExists:false}});

// Gate cannot accept stale, missing, failed, contradictory or no-go evidence.
for(const invalid of [
  {...gate,passed:false},{...gate,problems:['failed tests']},
  {...gate,evidenceRevision:'old'},{...gate,evidenceRevision:''},
  {...gate,expectedRevision:''},{...gate,verdict:'no-go' as const}
]) rejected(at('review','working'),'complete','gate','gate-rejected',{gate:invalid});
rejected(at('review','working'),'complete','gate','gate-rejected',{gate:undefined});

// Required facts must be supplied by trusted adapters; absence fails closed.
rejected(at('build','ready'),'start','agent','precondition-failed',{facts:{}});
rejected(at('build','ready'),'start','agent','precondition-failed',{facts:{...facts,activeRun:true}});
rejected(at('build','working'),'block','agent','precondition-failed',{facts:{...facts,reportRecorded:false}});
rejected(at('build','blocked'),'retry','human','precondition-failed',{facts:{...facts,feedbackRecorded:false}});
rejected(at('build','waiting'),'rework','human','precondition-failed',{facts:{...facts,feedbackRecorded:false}});
rejected(at('build','working'),'recover','human','precondition-failed',{facts:{...facts,activeRun:true}});
rejected(at('build','working'),'recover','human','precondition-failed',{facts:{...facts,recoveryConfirmed:false}});
rejected(at('build','working'),'recover','human','precondition-failed',{facts:{...facts,reportRecorded:false}});

// Deployment events cannot override blocked state or bypass verified artifact identity.
for(const phase of phases) {
  rejected(at(phase,'blocked'),'deploy-stage','deployment-workflow','invalid-transition');
  rejected(at(phase,'blocked'),'deploy-prod','deployment-workflow','invalid-transition');
}
for(const key of ['approvedMergedPr','deploymentVerified','changeIncluded'] as const)
  rejected(at('review','waiting'),'deploy-stage','deployment-workflow','precondition-failed',{facts:{...facts,[key]:false}});
for(const key of ['deploymentVerified','changeIncluded'] as const)
  rejected(at('accept','waiting'),'deploy-prod','deployment-workflow','precondition-failed',{facts:{...facts,[key]:false}});
rejected(at('observe','waiting'),'close','human','precondition-failed',{facts:{...facts,observeGo:false}});
console.log('Delivery transition matrix passed: '+assertions+' assertions');
