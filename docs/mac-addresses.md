# Mac addresses and fallback

A saved Mac can have up to six HTTPS addresses. Open **Mac options → Manage
addresses** to verify and add an address, remove one, or choose the preferred address.
Keep at least one address. To replace one, add and verify its replacement, then
remove the old one. Removing the preferred address selects the first remaining address.

Verification compares the complete TLS leaf certificate with the saved certificate.
Adding an address preserves the saved profile ID, client credential, authorization-mode
hint, and certificate pin. Connecting the same verified Mac through **Connect a Mac**
also adds its address to the existing pairing. An advertised name or fingerprint cannot
establish an alias. Discovery hides only addresses already verified and saved; a new
address remains separate until verified. Matching names never merge Macs.

The preferred address is tried first on a new workspace lifetime. A successful fallback
becomes the current route until it fails or the preference changes, avoiding repeated
delays on an unreachable preferred address. The header and address editor show the
current route and mark it as a fallback when different from the preference. Route
selection checks at most six addresses, once each, with a two-second wall-clock deadline
per address. Disconnect cancels pending stream selection and automatic retries.

Every HTTPS action, WSS connection, upload, and recording download verifies its route
before sending credentials. Each subsequent connection independently enforces the same
certificate pin, including if the endpoint changes after preflight. A certificate error
stops selection and requires explicit fingerprint verification and pairing; it never
updates the pin or relaxes TLS checks. An exhausted route set explains how to reconnect.

Fallback happens during preflight, before an action is sent. Each action dispatches once.
If the connection fails after dispatch, Sim Relay reports the failure without replaying
the command on another address. Check the simulator's state before manually retrying an
action that may already have completed. Streams retain their Mac/profile and simulator
IDs across bounded reconnects. No input is queued for replay. Changing the preferred
address or removing the active address disconnects the display; reconnect explicitly.
Existing display ownership checks still prevent duplicate desktop controllers, and the
Mac continues to enforce browser controller conflicts.

Single-address profiles migrate without changing their identity or authorization.
This is a client feature: protocol 1 hosts need no route API upgrade, retain legacy
shared-token behavior, and still require compatible TLS and `/info` responses. Protocol 2
hosts retain their per-client credential, revocation, and permission checks. Routing
cannot grant access or bypass a revoked credential.

Browser deployment owners must allow **every** route in `SIM_RELAY_WEB_HOSTS`, including
its exact HTTPS scheme and port. The relay checks the entire supplied address set,
current route, and new verification candidate before contacting any Mac. A disallowed
fallback causes rejection of the request, even if the preferred address is allowed.
Allowlisting never establishes Mac identity; each allowed address still needs the exact
paired certificate. Browser sign-in, workspace reset protection, and local profile
storage rules remain in effect. Addresses are visible in the workspace, while reviewed
diagnostic reports continue to exclude addresses, certificate material, and credentials.
