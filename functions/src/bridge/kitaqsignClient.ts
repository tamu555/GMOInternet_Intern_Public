/**
 * Kitaqsign client. TLDs: .com .net .org .info.
 *
 * Only `hello` differs from the shared implementation: Kitaqsign returns a
 * typed `GreetingResponse` with `registryCode` / `tlds` / `message`.
 */
import {BaseRegistryClient, type Route} from "./registryClient";
import type {RegistryGreeting} from "./types";

interface GreetingResponse {
  registryCode: string;
  tlds: string[];
  message: string;
}

/** RegistryClient bound to Kitaqsign. */
export class KitaqsignClient extends BaseRegistryClient {
  /** Creates a client for the Kitaqsign registry. */
  constructor() {
    super("kitaqsign");
  }

  /** @inheritdoc */
  async hello(clTRID: string): Promise<RegistryGreeting> {
    const answer = await this.http.send<GreetingResponse>({
      command: "session:hello",
      method: "GET",
      path: "/sessions/hello",
      clTRID,
      idempotent: true,
    });
    return {
      registry: this.registry,
      registryCode: answer.resData?.registryCode,
      tlds: answer.resData?.tlds ?? [],
      message: answer.resData?.message,
    };
  }

  /** @inheritdoc */
  protected pollRoute(): Route {
    return {method: "GET", path: "/messages/poll"};
  }

  /** @inheritdoc */
  protected ackRoute(id: string): Route {
    return {
      method: "POST",
      path: `/messages/${encodeURIComponent(id)}/ack`,
    };
  }
}
