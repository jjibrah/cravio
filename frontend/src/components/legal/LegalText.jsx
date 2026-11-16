// Renders terms written in a tiny plain-text format: "# Heading", "## Subheading", "- bullet", blank line = new paragraph.
// Everything is rendered as React text, never as HTML, so what an admin types can't inject markup.
import './legal.css';

export function parseLegal(body = '') {
  const blocks = [];
  let list = null;
  let para = [];
  const flush = () => { if (para.length) blocks.push({ type: 'p', text: para.join(' ') }); para = []; if (list) { blocks.push(list); list = null; } };
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('## ')) { flush(); blocks.push({ type: 'h3', text: line.slice(3) }); continue; }
    if (line.startsWith('# ')) { flush(); blocks.push({ type: 'h2', text: line.slice(2) }); continue; }
    if (/^[-*] /.test(line)) { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } list ||= { type: 'ul', items: [] }; list.items.push(line.slice(2)); continue; }
    if (list) { blocks.push(list); list = null; }
    para.push(line);
  }
  flush();
  return blocks;
}

export default function LegalText({ body }) {
  return <div className="legal-text">{parseLegal(body).map((block, index) => {
    if (block.type === 'h2') return <h2 key={index}>{block.text}</h2>;
    if (block.type === 'h3') return <h3 key={index}>{block.text}</h3>;
    if (block.type === 'ul') return <ul key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
    return <p key={index}>{block.text}</p>;
  })}</div>;
}

export const formatLegalDate = (iso) => new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
