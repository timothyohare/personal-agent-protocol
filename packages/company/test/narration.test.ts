import { expect, test } from "vitest";
import { narratedFlow } from "../../../test-support/narration.ts";

// N6: one human-readable line per protocol step, with no secrets (random ids normalised).
test("the company narrates a full sign-in lifecycle, including refusals", async () => {
  expect(await narratedFlow()).toEqual([
    "[company] agent.verified client_id=https://agent.example/agent.json client_name=Test Agent",
    "[company] session.started session_id=ses_* client_id=https://agent.example/agent.json user_id=u_* signed_in=false",
    "[company] session.renewed session_id=ses_* client_id=https://agent.example/agent.json",
    "[company] authorize.rejected reason=invalid_client detail=fetch failed for https://nobody.example/agent.json: fetch failed: no route for https://nobody.example/agent.json",
    "[company] authorize.rejected reason=redirect_uri client_id=https://agent.example/agent.json",
    "[company] authorize.rejected reason=pkce client_id=https://agent.example/agent.json",
    "[company] authorize.rejected reason=invalid_scope scope=admin",
    "[company] authorize.started client_id=https://agent.example/agent.json scope=poppy:read",
    "[company] login.failed client_id=https://agent.example/agent.json",
    "[company] login.ok account=acct_tipper",
    "[company] consent.declined client_id=https://agent.example/agent.json",
    "[company] authorize.started client_id=https://agent.example/agent.json scope=poppy:read standings",
    "[company] login.ok account=acct_tipper",
    "[company] consent.granted client_id=https://agent.example/agent.json scope=poppy:read standings",
    "[company] session.signed_in session_id=ses_* client_id=https://agent.example/agent.json account=acct_tipper scope=poppy:read standings",
    "[company] session.refreshed session_id=ses_* client_id=https://agent.example/agent.json account=acct_tipper new_session=true rotated=false",
    "[company] api.rejected error=invalid_dpop_proof path=/api/fixtures detail=invalid_dpop_proof: missing DPoP proof",
    "[company] account_token.revoked client_id=https://agent.example/agent.json account=acct_tipper sessions_signed_out=2",
    "[company] token.rejected error=invalid_request detail=body must be application/x-www-form-urlencoded",
    "[company] revoke.rejected error=invalid_client detail=client assertion required",
  ]);
});
