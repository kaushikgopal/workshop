import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { allowLoopbackEveRequests } from "../lib/allow-loopback-eve-requests.ts";

export default eveChannel({
  auth: [vercelOidc(), localDev(), allowLoopbackEveRequests(), placeholderAuth()],
});
