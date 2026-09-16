'use client'

import { useState } from 'react'

type Comment = {
  author: string
  role: string
  time: string
  body: React.ReactNode
  tone?: 'resolved' | 'agent'
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <button className="toggle-control" type="button" aria-pressed={checked} onClick={onChange}>
      <span className={`switch ${checked ? 'is-on' : ''}`} aria-hidden="true"><span /></span>
      <span>{label}</span>
    </button>
  )
}

function CommentCard({ comment }: { comment: Comment }) {
  return (
    <article className={`comment-card ${comment.tone ?? ''}`}>
      <header className="comment-head">
        <span className="avatar">{comment.role === 'AI agent' ? 'A' : comment.author.slice(0, 1)}</span>
        <div><strong>{comment.author}</strong><span>{comment.role}</span></div>
        <time>{comment.time}</time>
      </header>
      <div className="comment-body">{comment.body}</div>
      {comment.tone === 'agent' && <button className="show-more" type="button">show more <span>⌄</span></button>}
      {comment.tone === 'resolved' && <div className="resolved-label"><span>✓</span> resolved in round 2</div>}
    </article>
  )
}

export default function Page() {
  const [dark, setDark] = useState(false)
  const [lineNumbers, setLineNumbers] = useState(true)
  const [outline, setOutline] = useState(false)

  return (
    <main className={`app-shell ${dark ? 'theme-dark' : ''}`}>
      <div className="topbar">
        <div className="brand">akapen<span>.</span></div>
        <div className="file-context"><span className="file-icon">▱</span><span>notes/research-note.md</span><span className="dirty-dot" /></div>
        <div className="round-control"><span className="eyebrow">REVIEW ROUND</span><button type="button">Round 03 <span>⌄</span></button></div>
        <div className="top-actions">
          <button className={`text-control ${outline ? 'active' : ''}`} type="button" onClick={() => setOutline(!outline)}><span className="list-icon">☷</span> outline <span>⌄</span></button>
          <Toggle label="lines" checked={lineNumbers} onChange={() => setLineNumbers(!lineNumbers)} />
          <button className="theme-button" type="button" onClick={() => setDark(!dark)} aria-label="Toggle dark mode">{dark ? '☼' : '◐'}</button>
          <span className="comment-total"><span>●</span> 4 comments</span>
        </div>
      </div>

      <div className="round-banner"><span className="banner-mark">!</span><span>The file changed <strong>3 times</strong> since this round began</span><button type="button">End this round <span>→</span></button></div>

      <div className="workspace">
        <section className="document-wrap" aria-label="Rendered Markdown document">
          {outline && <aside className="outline-panel"><strong>On this page</strong><a href="#question">背景と目的</a><a href="#method">調査方法</a><a href="#findings">主な観察</a><a href="#next">次のアクション</a></aside>}
          <div className="paper">
            <div className="paper-meta"><span>RESEARCH NOTE / 2024.06.14</span><span>ROUND 03</span></div>
            <div className="markdown-grid">
              {lineNumbers && <div className="line-gutter" aria-hidden="true">{Array.from({ length: 34 }, (_, i) => <span key={i}>{String(i + 1).padStart(2, '0')}</span>)}</div>}
              <article className="markdown">
                <p className="kicker">フィールドノート 08</p>
                <h1>地域の小さな図書館が<br />つくる、偶然の余白</h1>
                <p className="lede">本を借りるためだけではない場所は、どのようにして街の日常に根づくのか。都内の独立系図書館を訪ね、空間と運営のあいだにある「余白」を記録した。</p>
                <div className="byline">調査・執筆：佐藤 真理　　最終更新：2024年6月14日</div>
                <hr />
                <h2 id="question" className="anchor-target">背景と目的</h2>
                <p>近年、図書館は「静かに本を読む場所」から、地域の人がゆるやかに滞在するための場所へと役割を広げている。一方で、利用目的を明確にしない滞在は、既存の評価指標からこぼれやすい。</p>
                <p>本稿では、利用者同士の会話や、予定されていない行動が生まれる瞬間に注目する。</p>
                <div className="annotation-line"><span className="review-marker">1</span><p><strong>問い：</strong>「余白」は設計されたもの？ それとも運営の結果として生まれるもの？</p></div>
                <h2 id="method">調査方法</h2>
                <h3>観察対象</h3>
                <ul><li>東京・谷中の独立系図書館 3館</li><li>平日と休日、それぞれ午前・午後の計12時間</li><li>来館者への短時間インタビュー（n=18）</li></ul>
                <h3>記録の視点</h3>
                <table><thead><tr><th>観察項目</th><th>見るポイント</th><th>記録方法</th></tr></thead><tbody><tr><td>滞在</td><td>予定外の滞在が起きた場所</td><td>平面図にプロット</td></tr><tr><td>接点</td><td>会話が始まるきっかけ</td><td>時刻と状況を記述</td></tr><tr><td>選択</td><td>本を選ぶまでの動線</td><td>短い追跡観察</td></tr></tbody></table>
                <h2 id="findings" className="anchor-target">主な観察</h2>
                <p>「何もしなくてよい」席が、利用者の行動を決めすぎない。窓際の長いベンチや、返却台の近くに置かれた小さな椅子は、目的のない立ち止まりを許容していた。</p>
                <div className="code-block"><div className="code-label">観察メモ / 13:42</div><code><span>visitor</span>: 「ここ、待ち合わせにも使えるんですね」<br /><span>staff</span>: 「そうですね。本がなくても大丈夫です」</code></div>
                <div className="mermaid"><span>flowchart LR</span><div><b>入館</b><i>→</i><b>滞在</b><i>→</i><b>偶然の接点</b><i>→</i><b>再訪</b></div><small>mermaid diagram placeholder</small></div>
                <h2 id="next">次のアクション</h2>
                <ol><li>「目的のない滞在」を支える家具配置を比較する</li><li>スタッフの声かけと、会話の発生率を記録する</li><li>利用者が名前をつけていない価値を言語化する</li></ol>
              </article>
            </div>
          </div>
        </section>

        <aside className="comment-rail" aria-label="Review comments">
          <div className="rail-header"><span>COMMENTS</span><button type="button">＋</button></div>
          <div className="comment-stack">
            <CommentCard comment={{ author: 'あなた', role: 'reviewer', time: '10:18', body: <p>この「余白」は、誰にとっての余白でしょう？</p> }} />
            <CommentCard comment={{ author: 'Aka', role: 'AI agent', time: '10:21', tone: 'agent', body: <><p>良い問いです。ここでいう余白は、利用者が自分の目的を持ち込める状態を指しています。</p><p>ただし、誰もが同じように使えるわけではありません。次の節で、滞在者の属性による違いにも触れられそうです。</p></> }} />
            <CommentCard comment={{ author: '井上', role: 'reviewer', time: '昨日', tone: 'resolved', body: <p>「独立系」の定義を脚注で補足してください。</p> }} />
          </div>
          <div className="carried-section"><div className="carried-heading"><span>carried over</span><span>1 unresolved</span></div><CommentCard comment={{ author: 'Aka', role: 'AI agent', time: 'round 02', body: <p>インタビュー対象の選定基準は、もう少し詳しく書けそうです。</p> }} /></div>
        </aside>
      </div>
    </main>
  )
}
