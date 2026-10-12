// The personal agent across companies: one CompanyClient per company, each with its own random
// User ID and DPoP key (spec 4.2, F29).
import { CompanyClient, type AgentDeps } from "./company.ts";
import { hostOf } from "./discover.ts";

export class PoppyAgent {
  private readonly deps: AgentDeps;
  private readonly companies = new Map<string, CompanyClient>();

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  company(input: string): CompanyClient {
    const host = hostOf(input);
    let c = this.companies.get(host);
    if (!c) this.companies.set(host, c = new CompanyClient(host, this.deps));
    return c;
  }
}
