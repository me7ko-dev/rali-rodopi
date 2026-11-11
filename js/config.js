// Where the online server lives. The only place with the address.
// ?api=off plays without the server; ?api=http://localhost:8798 uses a local `wrangler dev`.
const param = new URLSearchParams(location.search).get('api');
export const API = param === 'off' ? '' : (param || 'https://rali-api.metko.uk').replace(/\/$/, '');
