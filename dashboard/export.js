const section = (title, value) => `## ${title}\n\n${value || "미기록"}\n\n`;
const bullet = values => values.length ? values.map(value => `- ${value}`).join("\n") : "미연결";

export function buildUpMarkdown(entry, state) {
  const name = (items, id) => items.find(item => item.id === id)?.title || items.find(item => item.id === id)?.name || id;
  return `# ${entry.title}\n\nID: ${entry.id}\n종류: ${entry.kind}\n상태: ${entry.status} (사용자 기록; 과학적 검증 여부가 아님)\n생성: ${entry.createdAt}\n수정: ${entry.updatedAt}\n상위: ${entry.parentId || "없음"}\n\n` +
    section("Context · 내용", entry.body) + section("Options · 대안", entry.alternatives) +
    section("Decision · 선택 이유", entry.rationale) + section("Evidence · 근거와 검증", entry.evidence) +
    section("Next · 다음 검증", entry.nextStep) +
    section("연결 논문", bullet(entry.paperIds.map(id => `${name(state.papers, id)} (${id})`))) +
    section("연결 개념", bullet(entry.conceptIds.map(id => `${name(state.concepts, id)} (${id})`))) +
    section("Strataa skills", bullet(entry.skillNames)) +
    (entry.flowRef ? section("공개 Flow 캡처", `실행: ${entry.flowRef.id}\n상태: ${entry.flowRef.status}\n\n${entry.flowRef.request}`) : "") +
    (entry.history.length ? section("이전 버전", entry.history.map((old, index) => `### ${index + 1} · ${old.updatedAt}\n\n${old.title}\n\n${old.body}\n\n대안: ${old.alternatives}\n\n선택 이유: ${old.rationale}\n\n근거: ${old.evidence}\n\n다음 검증: ${old.nextStep}`).join("\n\n")) : "");
}

export function paperMarkdown(paper, state) {
  let result = `# ${paper.title}\n\nID: ${paper.id}\n저자: ${paper.authors || "미기록"}\n연도: ${paper.year || "미기록"}\n출처: ${paper.sourceUrl || "미기록"}\n\n` + section("읽기 노트", paper.notes);
  if (paper.analysis) {
    result += `자동 분석 초안 · ${paper.analysis.model} · ${paper.analysis.analyzedAt}\n\n`;
    for (const [field, title] of [["summary", "요약"], ["problem", "문제"], ["method", "방법"], ["findings", "논문이 보고한 결과"], ["limitations", "한계"]]) result += section(title, paper.analysis[field]);
  }
  result += section("Top-down 개념과 원문 근거", paper.conceptLinks.map(link => {
    const concept = state.concepts.find(item => item.id === link.conceptId);
    const parents = [];
    let parent = concept;
    while (parent) { parents.unshift(parent.name); parent = state.concepts.find(item => item.id === parent.parentId); }
    return `### ${parents.join(" → ")}\n\nID: ${link.conceptId} · ${concept?.review || "draft"}\n\n${link.note}\n\n${link.quote.split("\n").map(line => `> ${line}`).join("\n")}`;
  }).join("\n\n"));
  result += section("연결된 연구 BuildUp", bullet(state.buildUps.filter(entry => entry.paperIds.includes(paper.id)).map(entry => `${entry.title} (${entry.id}) — ${entry.status}`)));
  const longest = Math.max(2, ...Array.from(paper.text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  return result + `## 원문\n\n${fence}text\n${paper.text}\n${fence}\n`;
}
