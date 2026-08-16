import { describe, expect, it } from "vitest";
import { RequestSafetyGuard } from "../src/jingshibang/security.js";

describe("request safety",()=>{it("allows observed routes and blocks download routes",()=>{const guard=new RequestSafetyGuard();expect(()=>guard.assertAllowedRequest("https://www.jingshibang.com/api/products","api")).not.toThrow();expect(()=>guard.assertAllowedRequest("https://www.jingshibang.com/api/download/123","api")).toThrow(/Blocked/);});it("rejects undiscovered ids",()=>{const guard=new RequestSafetyGuard();expect(()=>guard.assertKnownPaperId("123")).toThrow(/not discovered/);guard.registerPaperId("123");expect(()=>guard.assertKnownPaperId("123")).not.toThrow();});});
