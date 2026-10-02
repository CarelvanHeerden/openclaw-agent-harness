export interface PlannerCiSuggestion {
  readonly subTaskSeq: number;
  readonly id: string;
  readonly ciCheck?: string;
  readonly command?: string;
}
interface CiCheckBinding { context:string; appId?:number }

export function plannerCiDiagnostics(tasks: readonly {
  seq: number;
  requiredBehaviorChecks?: readonly { id: string; ciCheck?: string; command?: string }[];
}[]): PlannerCiSuggestion[] {
  return tasks.flatMap((task) => (task.requiredBehaviorChecks ?? [])
    .filter((check) => typeof check.ciCheck === "string" && check.ciCheck.trim().length > 0)
    .map((check) => ({
      subTaskSeq:task.seq,
      id:check.id,
      ciCheck:check.ciCheck!.trim(),
      ...(check.command?.trim()?{command:check.command.trim()}:{}),
    })));
}

export function resolveTrustedCiEvidence(input: {
  policyStatus: "readable" | "denied" | "indeterminate";
  policyChecks: readonly string[];
  observedChecks: readonly string[];
  policyBindings?: readonly {context:string;appId?:number}[];
  observedBindings?: readonly {context:string;appId?:number}[];
  explicitChecks?: readonly string[];
  providerState: "success" | "failure" | "pending" | "indeterminate";
}): {
  registered: boolean;
  requiredChecks: string[];
  successfulChecks: string[];
  status: "success" | "failure" | "pending" | "indeterminate";
} {
  const observedChecks=[...new Set(input.observedChecks.map((name)=>name.trim()).filter(Boolean))];
  const policyChecks=[...new Set(input.policyChecks.map((name)=>name.trim()).filter(Boolean))];
  const explicitChecks=[...new Set((input.explicitChecks??[]).map((name)=>name.trim()).filter(Boolean))];
  const observedBindings:CiCheckBinding[]=(input.observedBindings??observedChecks.map((context)=>({context})))
    .filter((binding)=>binding.context.trim())
    .map((binding)=>({context:binding.context.trim(),...("appId" in binding&&Number.isSafeInteger(binding.appId)&&binding.appId!>0?{appId:binding.appId}:{})}));
  const policyBindings:CiCheckBinding[]=(input.policyBindings??policyChecks.map((context)=>({context})))
    .filter((binding)=>binding.context.trim())
    .map((binding)=>({context:binding.context.trim(),...("appId" in binding&&Number.isSafeInteger(binding.appId)&&binding.appId!>0?{appId:binding.appId}:{})}));
  const requiredBindings:CiCheckBinding[]=[
    ...(policyBindings.length>0?policyBindings:explicitChecks.length>0?[]:observedBindings),
    ...explicitChecks.map((context):CiCheckBinding=>({context})),
  ];
  const requiredChecks=[...new Set(requiredBindings.map((binding)=>binding.context))];
  const successfulChecks=input.providerState==="success"
    ? [...new Set(requiredBindings
      .filter((required)=>observedBindings.some((observed)=>observed.context===required.context&&(required.appId===undefined||observed.appId===required.appId)))
      .map((binding)=>binding.context))]
    : [];
  const status =
    input.policyStatus!=="readable" ? "indeterminate"
    : input.providerState==="failure" ? "failure"
    : input.providerState==="pending" ? "pending"
    : input.providerState==="success" && requiredBindings.length>0 &&
      requiredBindings.every((required)=>observedBindings.some((observed)=>observed.context===required.context&&(required.appId===undefined||observed.appId===required.appId))) ? "success"
    : "indeterminate";
  return {
    registered:input.policyStatus==="readable"&&requiredChecks.length>0,
    requiredChecks,
    successfulChecks,
    status,
  };
}

export function exactSuccessfulRequiredChecks(
  trustedSuccessfulChecks:readonly string[],
  exactSuccessConclusions:readonly string[],
  requiredBindings:readonly {context:string;appId?:number}[]=trustedSuccessfulChecks.map((context)=>({context})),
  exactSuccessBindings:readonly {context:string;appId?:number}[]=exactSuccessConclusions.map((context)=>({context})),
):string[] {
  const exact=new Set(exactSuccessConclusions);
  return [...new Set(trustedSuccessfulChecks.filter((check)=>{
    if(!exact.has(check))return false;
    const requirements=requiredBindings.filter((binding)=>binding.context===check);
    if(requirements.length===0)return false;
    return requirements.every((required)=>exactSuccessBindings.some((observed)=>
      observed.context===required.context&&(required.appId===undefined||observed.appId===required.appId)
    ));
  }))];
}
