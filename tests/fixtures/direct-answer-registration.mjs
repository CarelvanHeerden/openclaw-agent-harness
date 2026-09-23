/**
 * Historical answer-path tests model a human response. Instantiate the
 * contextual tool with the host-authenticated requester and add the explicit
 * provenance marker older tests predate. Security/provenance tests import
 * production registration directly.
 */
import {registerHarnessTools as register} from '../../dist/tools/registration.js';

export function registerHarnessTools(api, runtime) {
 return register({...api,
  registerTool(def,...rest) {
   if(def.name!=='harness_answer') return api.registerTool(def,...rest);
   const contextual=typeof def==='function' ? def({requesterSenderId:'U1'}) : def;
   const wrapped={...contextual,execute:async(...args)=>{
    const index=args.length-1;const input=args[index];
    if(input && typeof input==='object' && input.answeredBy===undefined) args[index]={...input,answeredBy:'human'};
    return contextual.execute(...args);
   }};
   return api.registerTool(wrapped,...rest);
  },
 },runtime);
}
