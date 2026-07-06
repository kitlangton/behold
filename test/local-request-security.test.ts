import { describe, expect, it } from "vitest"
import { isTrustedLocalRequest } from "../server/local-request-security"

describe("local request security", () => {
  it("accepts supported loopback hosts", () => {
    expect(isTrustedLocalRequest({ host: "behold.localhost:5173" })).toBe(true)
    expect(isTrustedLocalRequest({ host: "127.0.0.1:5173" })).toBe(true)
    expect(isTrustedLocalRequest({ host: "localhost:5173" })).toBe(true)
    expect(isTrustedLocalRequest({ host: "[::1]:5173" })).toBe(true)
  })

  it("rejects DNS rebinding hosts", () => {
    expect(isTrustedLocalRequest({ host: "attacker.example:5173" })).toBe(false)
    expect(isTrustedLocalRequest({ host: "" })).toBe(false)
  })

  it("requires the Behold request header for local mutations", () => {
    expect(isTrustedLocalRequest({ method: "POST", host: "127.0.0.1:5173" })).toBe(false)
    expect(isTrustedLocalRequest({ method: "POST", host: "127.0.0.1:5173", beholdRequest: "1" })).toBe(true)
  })

  it("rejects cross-site and mismatched-origin browser mutations", () => {
    expect(isTrustedLocalRequest({ method: "POST", host: "behold.localhost:5173", secFetchSite: "cross-site", beholdRequest: "1" })).toBe(false)
    expect(isTrustedLocalRequest({ method: "DELETE", host: "behold.localhost:5173", origin: "https://attacker.example", beholdRequest: "1" })).toBe(false)
    expect(isTrustedLocalRequest({ method: "POST", host: "behold.localhost:5173", origin: "http://behold.localhost:5173", beholdRequest: "1" })).toBe(true)
  })
})
