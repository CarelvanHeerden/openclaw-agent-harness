/**
 * Migrate historical handler/business-logic tests to the real non-agent command
 * path. A human test invocation simulates authenticated host command delivery;
 * automation still exercises the actual tool. Security tests import production
 * registration directly and MUST NOT use this adapter.
 */
import {registerHarnessTools as register} from '../../dist/tools/registration.js';
export function registerHarnessTools(api, runtime) {
 let command;
 const wrap = (def, context) => ({...def, execute: async (...args) => {
  const input=args[1];
  if(input?.answeredBy==='automation') return def.execute(...args);
  const sender=context?.requesterSenderId ?? input?.invokedBy;
  const invoke=(body)=>command.handler({senderId:sender,channel:'slack',isAuthorizedSender:true,args:body,commandBody:'/harness-answer '+body});
  const review=await invoke(input.sessionId);
  const challenge=review.text.match(/\/harness-answer \S+ ([a-f0-9]{48})/);
  const pageCount=Number(review.text.match(/page 1\/(\d+)/)?.[1] ?? 1);
  if(challenge) for(let page=2;page<=pageCount;page++) {
   await invoke(`${input.sessionId} ${challenge[1]} review ${page}`);
  }
  const result=challenge?await invoke(`${input.sessionId} ${challenge[1]} ${input.answer}`):review;
  return {content:[{type:'text',text:result.text}],details:result.details??{ok:false}};
 }});
 return register({...api,
  registerCommand(def){command=def;return api.registerCommand?.(def);},
  registerTool(def,...rest){
   if(def.name!=='harness_answer')return api.registerTool(def,...rest);
   const factory=(context)=>wrap(def(context),context);
   Object.defineProperty(factory,'name',{value:def.name,configurable:true});
   Object.assign(factory,Object.fromEntries(Object.entries(wrap(def({requesterSenderId:'U1'}))).filter(([k])=>k!=='name')));
   return api.registerTool(factory,...rest);
  }
 },runtime);
}
