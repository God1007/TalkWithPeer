export function parseJsonResponse(text) {
  if (typeof text !== "string" || text.length > 64000)
    throw new Error("Agent 返回格式无效。");
  const clean = text.trim();
  // Accept a single fenced JSON document, never code or trailing instructions.
  const fence = String.fromCharCode(96).repeat(3);
  const json = clean.startsWith(fence)
    ? clean
        .slice(fence.length)
        .replace(/^json\s*/, "")
        .replace(new RegExp("\\s*" + fence + "$"), "")
    : clean;
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Agent 没有返回约定的结构化回答。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Agent 回答必须是一个对象。");
  return value;
}
export function parseResponse(text) {
  const value = parseJsonResponse(text);
  if (
    typeof value.message !== "string" ||
    !value.message.trim() ||
    value.message.length > 24000
  )
    throw new Error("Agent 没有返回有效的公开观点。");
  return value;
}
export function validateOpinion(value) {
  if (
    typeof value.proposal !== "string" ||
    !value.proposal.trim() ||
    value.proposal.length > 12000
  )
    throw new Error("Agent 没有提出有效候选结果。");
  return { message: value.message, proposal: value.proposal };
}
export function validateVote(value, candidate, members) {
  if (value.candidateId !== candidate.id)
    throw new Error("Agent 判断使用了过期的候选版本。");
  if (!["accept", "revise", "reject"].includes(value.stance))
    throw new Error("Agent 判断状态无效。");
  if (typeof value.acceptsSolution !== "boolean")
    throw new Error("Agent 必须明确是否接受候选作为原问题的解决方案。");
  if (
    !Array.isArray(value.disagreements) ||
    value.disagreements.length > members.length
  )
    throw new Error("Agent 分歧记录无效。");
  for (const d of value.disagreements) {
    if (
      !members.some((m) => m.id === d.memberId) ||
      typeof d.reason !== "string" ||
      !d.reason.trim() ||
      d.reason.length > 2000 ||
      typeof d.nonNegotiable !== "boolean"
    )
      throw new Error("Agent 分歧对象无效。");
  }
  if (value.acceptsSolution && value.stance !== "accept")
    throw new Error("Agent 对解决方案的接受判断互相矛盾。");
  if (
    value.stance === "revise" &&
    (typeof value.proposal !== "string" ||
      !value.proposal.trim() ||
      value.proposal.length > 12000)
  )
    throw new Error("修改意见缺少有效的新提议。");
  return {
    message: value.message,
    candidateId: value.candidateId,
    stance: value.stance,
    acceptsSolution: value.acceptsSolution,
    proposal: typeof value.proposal === "string" ? value.proposal : null,
    disagreements: value.disagreements,
  };
}
export function judgeRound({ candidate, members, votes, round }) {
  const ids = members.map((m) => m.id);
  if (
    !ids.length ||
    votes.length !== ids.length ||
    new Set(votes.map((v) => v.memberId)).size !== ids.length ||
    votes.some(
      (v) => !ids.includes(v.memberId) || v.candidateId !== candidate.id,
    )
  )
    return null;
  if (
    votes.every(
      (v) =>
        v.stance === "accept" &&
        v.acceptsSolution === true &&
        !v.disagreements.some((d) => d.nonNegotiable),
    )
  )
    return {
      kind: "consensus",
      candidateId: candidate.id,
      text: candidate.text,
      memberIds: ids,
    };
  // Two review rounds ensure each side has seen the other's explicit judgment.
  if (round < 2) return null;
  for (const a of votes) {
    for (const d of a.disagreements.filter(
      (d) => d.nonNegotiable && d.memberId !== a.memberId,
    )) {
      const b = votes.find((v) => v.memberId === d.memberId);
      const reciprocal = b?.disagreements.find(
        (e) => e.memberId === a.memberId && e.nonNegotiable,
      );
      if (b && reciprocal && !(a.acceptsSolution && b.acceptsSolution))
        return {
          kind: "deadlock",
          candidateId: candidate.id,
          memberIds: [a.memberId, b.memberId],
          positions: [
            { memberId: a.memberId, reason: d.reason },
            { memberId: b.memberId, reason: reciprocal.reason },
          ],
          text: "两位参与者在交流后仍保留相互冲突的不可让步立场。",
        };
    }
  }
  return null;
}
