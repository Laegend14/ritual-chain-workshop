import assert from "node:assert";
import hre from "hardhat";
import { describe, it } from "node:test";
import { keccak256, encodePacked, stringToBytes } from "viem";

describe("AIJudge Commit-Reveal Bounty System", function () {
  // Helper to initialize Hardhat 3 Network & Viem
  async function setup() {
    const net = await (hre.network as any).create();
    const viem = net.viem;
    const [ownerWallet, participant1, participant2] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const aiJudge = await viem.deployContract("AIJudge");
    return {
      aiJudge,
      ownerWallet,
      participant1,
      participant2,
      publicClient,
      viem,
    };
  }

  // Helper to generate salt
  const generateSalt = (seed: string): `0x${string}` => {
    return keccak256(stringToBytes(seed));
  };

  // Helper to compute commitment hash matching the Solidity side
  const computeCommitment = (
    answer: string,
    salt: `0x${string}`,
    sender: `0x${string}`,
    bountyId: bigint
  ): `0x${string}` => {
    return keccak256(
      encodePacked(
        ["string", "bytes32", "address", "uint256"],
        [answer, salt, sender, bountyId]
      )
    );
  };

  // Helper to fast forward time using standard Viem public client requests
  async function fastForward(publicClient: any, seconds: number) {
    await publicClient.request({
      method: "evm_increaseTime",
      params: [seconds],
    });
    await publicClient.request({
      method: "evm_mine",
    });
  }

  it("should allow a bounty to be created with submission and reveal deadlines", async function () {
    const { aiJudge, ownerWallet, publicClient } = await setup();

    const title = "Simple Logic Question";
    const rubric = "Verify correctness and clarity.";
    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 1000n;
    const revealDeadline = currentTime + 2000n;

    // Create bounty
    const hash = await aiJudge.write.createBounty([title, rubric, deadline, revealDeadline], {
      value: 1000000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const bounty = await aiJudge.read.getBounty([1n]);
    assert.strictEqual(bounty[0].toLowerCase(), ownerWallet.account.address.toLowerCase());
    assert.strictEqual(bounty[1], title);
    assert.strictEqual(bounty[2], rubric);
    assert.strictEqual(bounty[3], 1000000n); // reward
    assert.strictEqual(bounty[4], deadline);
    assert.strictEqual(bounty[5], revealDeadline);
    assert.strictEqual(bounty[6], false); // judged
    assert.strictEqual(bounty[7], false); // finalized
  });

  it("should allow participants to submit commitments before the submission deadline", async function () {
    const { aiJudge, participant1, publicClient, viem } = await setup();

    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 1000n;
    const revealDeadline = currentTime + 2000n;

    await aiJudge.write.createBounty(["T1", "R1", deadline, revealDeadline], { value: 100000n });

    const answer = "My secret answer";
    const salt = generateSalt("salt1");
    const commitment = computeCommitment(answer, salt, participant1.account.address, 1n);

    // Submit commitment from participant1
    const p1Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant1 } });
    const hash = await p1Judge.write.submitCommitment([1n, commitment]);
    await publicClient.waitForTransactionReceipt({ hash });

    const storedCommitment = await aiJudge.read.commitments([1n, participant1.account.address]);
    assert.strictEqual(storedCommitment, commitment);
  });

  it("should revert if submitting commitment after submission deadline", async function () {
    const { aiJudge, participant1, publicClient, viem } = await setup();

    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 100n;
    const revealDeadline = currentTime + 200n;

    await aiJudge.write.createBounty(["T1", "R1", deadline, revealDeadline], { value: 100000n });

    const answer = "My secret answer";
    const salt = generateSalt("salt1");
    const commitment = computeCommitment(answer, salt, participant1.account.address, 1n);

    // Fast forward past the submission deadline
    await fastForward(publicClient, 150);

    const p1Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant1 } });
    await assert.rejects(
      async () => {
        await p1Judge.write.submitCommitment([1n, commitment]);
      },
      /submissions closed/
    );
  });

  it("should not allow revealing answers before the submission deadline", async function () {
    const { aiJudge, participant1, publicClient, viem } = await setup();

    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 1000n;
    const revealDeadline = currentTime + 2000n;

    await aiJudge.write.createBounty(["T1", "R1", deadline, revealDeadline], { value: 100000n });

    const answer = "My secret answer";
    const salt = generateSalt("salt1");
    const commitment = computeCommitment(answer, salt, participant1.account.address, 1n);

    const p1Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant1 } });
    await p1Judge.write.submitCommitment([1n, commitment]);

    // Try revealing before deadline (it is still submission phase)
    await assert.rejects(
      async () => {
        await p1Judge.write.revealAnswer([1n, answer, salt]);
      },
      /submission phase not closed/
    );
  });

  it("should verify commitment and allow reveal during the reveal phase", async function () {
    const { aiJudge, participant1, publicClient, viem } = await setup();

    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 100n;
    const revealDeadline = currentTime + 200n;

    await aiJudge.write.createBounty(["T1", "R1", deadline, revealDeadline], { value: 100000n });

    const answer = "My secret answer";
    const salt = generateSalt("salt1");
    const commitment = computeCommitment(answer, salt, participant1.account.address, 1n);

    const p1Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant1 } });
    await p1Judge.write.submitCommitment([1n, commitment]);

    // Fast forward to reveal phase (past submission deadline)
    await fastForward(publicClient, 120);

    // Reveal answer
    const hash = await p1Judge.write.revealAnswer([1n, answer, salt]);
    await publicClient.waitForTransactionReceipt({ hash });

    // Verify submission is stored and commitment is cleared
    const storedCommitment = await aiJudge.read.commitments([1n, participant1.account.address]);
    assert.strictEqual(storedCommitment, "0x0000000000000000000000000000000000000000000000000000000000000000");

    const bounty = await aiJudge.read.getBounty([1n]);
    assert.strictEqual(bounty[8], 1n); // submissionCount

    const submission = await aiJudge.read.getSubmission([1n, 0n]);
    assert.strictEqual(submission[0].toLowerCase(), participant1.account.address.toLowerCase());
    assert.strictEqual(submission[1], answer);
  });

  it("should revert if revealing with incorrect answer, salt, or sender (commitment mismatch)", async function () {
    const { aiJudge, participant1, participant2, publicClient, viem } = await setup();

    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 100n;
    const revealDeadline = currentTime + 200n;

    await aiJudge.write.createBounty(["T1", "R1", deadline, revealDeadline], { value: 100000n });

    const answer = "My secret answer";
    const salt = generateSalt("salt1");
    const commitment = computeCommitment(answer, salt, participant1.account.address, 1n);

    const p1Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant1 } });
    await p1Judge.write.submitCommitment([1n, commitment]);

    await fastForward(publicClient, 120);

    // Case 1: Wrong answer
    await assert.rejects(
      async () => {
        await p1Judge.write.revealAnswer([1n, "wrong answer", salt]);
      },
      /commitment mismatch/
    );

    // Case 2: Wrong salt
    const wrongSalt = generateSalt("wrong");
    await assert.rejects(
      async () => {
        await p1Judge.write.revealAnswer([1n, answer, wrongSalt]);
      },
      /commitment mismatch/
    );

    // Case 3: Wrong sender trying to reveal participant1's answer
    const p2Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant2 } });
    await assert.rejects(
      async () => {
        await p2Judge.write.revealAnswer([1n, answer, salt]);
      },
      /no commitment to reveal/
    );
  });

  it("should prevent double revealing", async function () {
    const { aiJudge, participant1, publicClient, viem } = await setup();

    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 100n;
    const revealDeadline = currentTime + 200n;

    await aiJudge.write.createBounty(["T1", "R1", deadline, revealDeadline], { value: 100000n });

    const answer = "My secret answer";
    const salt = generateSalt("salt1");
    const commitment = computeCommitment(answer, salt, participant1.account.address, 1n);

    const p1Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant1 } });
    await p1Judge.write.submitCommitment([1n, commitment]);

    await fastForward(publicClient, 120);

    // First reveal
    await p1Judge.write.revealAnswer([1n, answer, salt]);

    // Second reveal should fail because commitment is deleted
    await assert.rejects(
      async () => {
        await p1Judge.write.revealAnswer([1n, answer, salt]);
      },
      /no commitment to reveal/
    );
  });

  it("should not allow judging before the reveal deadline", async function () {
    const { aiJudge, participant1, publicClient, viem } = await setup();

    const currentTime = BigInt(await publicClient.getBlock({ blockTag: "latest" }).then(b => b.timestamp));
    const deadline = currentTime + 100n;
    const revealDeadline = currentTime + 200n;

    await aiJudge.write.createBounty(["T1", "R1", deadline, revealDeadline], { value: 100000n });

    const answer = "My secret answer";
    const salt = generateSalt("salt1");
    const commitment = computeCommitment(answer, salt, participant1.account.address, 1n);

    const p1Judge = await viem.getContractAt("AIJudge", aiJudge.address, { client: { wallet: participant1 } });
    await p1Judge.write.submitCommitment([1n, commitment]);

    await fastForward(publicClient, 120);
    await p1Judge.write.revealAnswer([1n, answer, salt]);

    // Owner tries to judge before reveal deadline (block timestamp is still before revealDeadline)
    await assert.rejects(
      async () => {
        await aiJudge.write.judgeAll([1n, "0x00"]);
      },
      /reveal phase not ended/
    );
  });
});
