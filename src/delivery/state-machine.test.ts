import { decideTransition } from './state-machine.js';
import type { Position } from './state-machine.js';
const at = (phase: Position['phase'], status: Position['status']): Position => ({phase,status});
function check(ok: boolean, name: string) { if (!ok) throw new Error(name); }
check(decideTransition(null,{action:'initialize',actor:'human'}).allowed,'initialize');
check(!decideTransition(at('requirements','waiting'),{action:'advance',actor:'human',target:'build',facts:{taskSize:'L',miniDesignRecorded:true}}).allowed,'L skip');
check(decideTransition(at('requirements','waiting'),{action:'advance',actor:'human',target:'build',facts:{taskSize:'S',miniDesignRecorded:true}}).allowed,'S skip');
check(!decideTransition(at('accept','working'),{action:'complete',actor:'gate',gate:{passed:true,problems:[],evidenceRevision:'a',expectedRevision:'b'}}).allowed,'stale gate');
check(!decideTransition(at('review','blocked'),{action:'deploy-stage',actor:'deployment-workflow',facts:{approvedMergedPr:true,deploymentVerified:true,changeIncluded:true}}).allowed,'blocked preserved');
check(!decideTransition(at('observe','waiting'),{action:'close',actor:'agent',facts:{observeGo:true}}).allowed,'agent cannot close');
console.log('Delivery domain smoke tests passed');
