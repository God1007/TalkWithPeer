import test from "node:test";
import assert from "node:assert/strict";
import {
  parseResponse,
  validateOpinion,
  validateVote,
  judgeRound,
} from "../server/convergence.mjs";
const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
const candidate = { id: "candidate-2", text: "采用共享记录" };
const accept = (id) => ({
  memberId: id,
  candidateId: candidate.id,
  stance: "accept",
  acceptsSolution: true,
  message: "同意",
  disagreements: [],
});
test("all members must accept the same candidate", () => {
  assert.equal(
    judgeRound({
      candidate,
      members,
      votes: members.map((m) => accept(m.id)),
      round: 1,
    }).kind,
    "consensus",
  );
  assert.equal(
    judgeRound({
      candidate,
      members,
      votes: [accept("a"), accept("b")],
      round: 3,
    }),
    null,
  );
  assert.equal(
    judgeRound({
      candidate,
      members,
      votes: [accept("a"), accept("a"), accept("c")],
      round: 3,
    }),
    null,
  );
  assert.equal(
    judgeRound({
      candidate,
      members,
      votes: [accept("a"), accept("b"), { ...accept("c"), candidateId: "old" }],
      round: 3,
    }),
    null,
  );
});
test("deadlock requires reciprocal explicit refusal after exchange", () => {
  const a = {
    ...accept("a"),
    stance: "reject",
    acceptsSolution: false,
    disagreements: [
      { memberId: "b", reason: "必须保留全文", nonNegotiable: true },
    ],
  };
  const b = {
    ...accept("b"),
    stance: "revise",
    acceptsSolution: false,
    disagreements: [
      { memberId: "a", reason: "不能全量广播", nonNegotiable: true },
    ],
  };
  assert.equal(
    judgeRound({ candidate, members, votes: [a, b, accept("c")], round: 1 }),
    null,
  );
  assert.equal(
    judgeRound({
      candidate,
      members,
      votes: [a, b, accept("c")],
      round: 2,
      previousVotes: [a, b, accept("c")],
    }).kind,
    "deadlock",
  );
  assert.equal(
    judgeRound({
      candidate,
      members,
      votes: [a, { ...b, disagreements: [] }, accept("c")],
      round: 5,
    }),
    null,
  );
});
test("invalid or contradictory responses do not become votes", () => {
  assert.throws(() => parseResponse("我同意，大家都同意。"));
  assert.throws(() => validateOpinion({ message: "意见", proposal: "" }));
  assert.throws(() =>
    validateVote({ ...accept("a"), candidateId: "old" }, candidate, members),
  );
  assert.throws(() =>
    validateVote(
      {
        ...accept("a"),
        stance: "reject",
      },
      candidate,
      members,
    ),
  );
  assert.equal(
    parseResponse(JSON.stringify({ message: "意见", proposal: "提议" }))
      .proposal,
    "提议",
  );
});
test("agreement about a deadlock record is not solution consensus", () => {
  const a = {
    ...accept("a"),
    acceptsSolution: false,
    disagreements: [
      { memberId: "b", reason: "只能采用 A", nonNegotiable: true },
    ],
  };
  const b = {
    ...accept("b"),
    acceptsSolution: false,
    disagreements: [
      { memberId: "a", reason: "只能采用 B", nonNegotiable: true },
    ],
  };
  assert.equal(
    judgeRound({ candidate, members, votes: [a, b, accept("c")], round: 1 }),
    null,
  );
  assert.equal(
    judgeRound({
      candidate,
      members,
      votes: [a, b, accept("c")],
      round: 2,
      previousVotes: [a, b, accept("c")],
    }).kind,
    "deadlock",
  );
  assert.doesNotThrow(() => validateVote(a, candidate, members));
});
