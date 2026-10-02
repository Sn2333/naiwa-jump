/**
 * Cloudflare Pages Functions 入口 —— 把所有 /api/* 交给排行榜后端。
 *
 * 为什么从 Workers 换到 Pages：
 *   Workers 的默认域名 *.workers.dev 在国内整段打不开（DNS 被污染成假 IP，
 *   TLS 握手也被挡），而同一家的 Pages（*.pages.dev）实测可达。两者底层是
 *   同一套运行时，所以后端业务代码一行都没改，换掉的只是入口这一层壳。
 *
 * 顺带白赚两个好处：
 *   1. 网页和 API 落在同一个域名下 → 不需要跨域，CORS 那套彻底不用管了；
 *   2. 前端不用再填什么后端地址 → 少一个「地址填错」的失败点。
 *
 * 真源仍然是 ../../worker/src/index.js。这里只做一层薄桥接，不复制任何业务逻辑，
 * 所以不存在「两份代码要同步」的问题。
 *
 * 路径约定：Cloudflare 把 functions/api/[[path]].js 挂到 /api 以及它下面的所有
 * 子路径上（[[path]] 是可选的 catch-all）。具体是哪条接口，仍然由后端按
 * request.url 的 pathname 分发（/api/health、/api/submit、/api/rank）。
 */
import worker from '../../worker/src/index.js';

export const onRequest = (context) =>
  worker.fetch(context.request, context.env, context);
