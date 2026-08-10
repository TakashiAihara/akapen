// Tighten the standard library types.
// Mainly so JSON.parse and Response.json() return unknown instead of any, closing
// the path where anything passes the moment it is parsed.
import '@total-typescript/ts-reset';
