// 標準ライブラリの型を安全側に寄せる。
// JSON.parse / Response.json() が any ではなく unknown を返すようになるのが主目的で、
// 「parse した瞬間に何でも通る」経路を塞ぐ。
import '@total-typescript/ts-reset';
