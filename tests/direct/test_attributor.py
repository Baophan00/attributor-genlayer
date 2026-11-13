"""Direct-mode tests for Attributor.

    env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
        --with pytest --with genlayer-test pytest tests/direct -q

The page and the model are mocked; the contract is not: the same parsing,
scoring, proof and history code the validators run is exercised here.
"""

import hashlib
import json

CONTRACT = "contracts/attributor.py"
PROMPT = r"comparing a registered text"
CHALLENGE_PROMPT = r"dispute about a first-publication record"
SUSPECT = "https://copy.example.org/page"
ORIGIN = "https://origin.example.org/page"
EVIDENCE = "https://evidence.example.org/page"

WORK_TEXT = (
    "The quiet failure of every translation memory is that it remembers words and "
    "forgets decisions. A glossary is a decision: this product is called a payment "
    "gateway, not a payment door, in every sentence, forever. When the memory only "
    "keeps the sentence and drops the decision, the next translator writes a fluent "
    "page that the brand cannot ship, and the review happens at midnight before launch."
)


def who(addr):
    from genlayer import Address

    return str(Address(bytes(addr)))


def proof_for(sender):
    return f"attributor:owner={who(sender).lower()}"


def deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def mock(direct_vm, payload, pattern=PROMPT):
    direct_vm.mock_llm(pattern, payload if isinstance(payload, str) else json.dumps(payload))


def registered(contract, direct_vm, sender, work_id="essay-1", text=WORK_TEXT):
    direct_vm.clear_mocks()
    page = f"{text}\n\nPublished by the author.\n\n{proof_for(sender)}"
    direct_vm.mock_web(r"origin\.example\.org", {"status": 200, "body": page})
    direct_vm.sender = sender
    return contract.register_work(
        work_id, "Why glossaries fail at midnight", text, ORIGIN
    )


def attest(contract, direct_vm, sender, payload, suspect=SUSPECT, page="the copied page", work_id="essay-1"):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"copy\.example\.org", {"status": 200, "body": page})
    mock(direct_vm, payload)
    direct_vm.sender = sender
    return contract.attest_copy(work_id, suspect)


def challenge(contract, direct_vm, sender, payload, work_id="essay-1", reason=None):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"origin\.example\.org", {"status": 200, "body": WORK_TEXT + " (original page)"})
    direct_vm.mock_web(r"evidence\.example\.org", {"status": 200, "body": "Published January 2, 2026 by the same author."})
    mock(direct_vm, payload, pattern=CHALLENGE_PROMPT)
    direct_vm.sender = sender
    return contract.challenge_work(
        work_id, EVIDENCE, reason or "This text was published earlier at another URL by the same author."
    )


def verdict(category="near_copy", overlap="high", excerpt="a matched sentence", reason="same argument"):
    return {"category": category, "overlap": overlap, "excerpt": excerpt, "reason": reason}


def challenge_verdict(value="upheld", note="the evidence shows an earlier publication"):
    return {"verdict": value, "note": note}


class TestRegister:
    def test_a_registered_work_keeps_its_text_time_and_url(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        out = registered(contract, direct_vm, direct_alice)

        assert out["work_id"] == "essay-1"
        assert out["owner"] == who(direct_alice)
        assert out["chars"] == len(WORK_TEXT)
        assert out["published_url"] == ORIGIN
        assert out["created_at"] > 0
        assert out["verified"] is True
        assert out["proof_kind"] == "page_token"

        work = contract.get_work("essay-1")
        assert work["title"] == "Why glossaries fail at midnight"
        assert work["text"] == WORK_TEXT
        assert work["attestations"] == 0
        assert work["status"] == ""
        assert work["checked"] is False
        assert work["verified"] is True
        assert work["revoked"] is False
        assert work["challenges"] == 0
        assert contract.stats()["works"] == 1

    def test_the_proof_digest_and_text_digest_are_stored(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)

        work = contract.get_work("essay-1")
        proof = proof_for(direct_alice)
        assert work["proof_digest"] == hashlib.sha256(" ".join(proof.split()).encode()).hexdigest()
        assert work["text_digest"] == hashlib.sha256(" ".join(WORK_TEXT.split()).encode()).hexdigest()
        assert work["verified_at"] > 0

    def test_registration_requires_the_text_on_the_page(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.clear_mocks()
        page = "A page that does not contain the registered article.\n\n" + proof_for(direct_alice)
        direct_vm.mock_web(r"origin\.example\.org", {"status": 200, "body": page})
        direct_vm.sender = direct_alice

        with direct_vm.expect_revert("not found on the published page"):
            contract.register_work("no-text", "A title", WORK_TEXT, ORIGIN)
        assert contract.stats()["works"] == 0

    def test_registration_requires_the_owner_proof(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.clear_mocks()
        direct_vm.mock_web(r"origin\.example\.org", {"status": 200, "body": WORK_TEXT})
        direct_vm.sender = direct_alice

        with direct_vm.expect_revert("owner proof line was not found"):
            contract.register_work("essay-1", "A title", WORK_TEXT, ORIGIN)
        assert contract.stats()["works"] == 0

    def test_a_work_id_is_single_use(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)

        with direct_vm.expect_revert("is taken"):
            registered(contract, direct_vm, direct_alice)

    def test_a_work_id_must_be_token_safe(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("may use letters"):
            contract.register_work("bad id;", "A title", WORK_TEXT, ORIGIN)

    def test_short_text_is_refused(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("too short to compare"):
            contract.register_work("tiny", "A note", "forty characters is not a work", "https://a.example.org")

    def test_the_published_url_must_be_http(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("not an http"):
            contract.register_work("w", "A title", WORK_TEXT, "origin.example.org")

    def test_the_same_text_cannot_be_registered_twice(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice, "a1")
        direct_vm.sender = direct_bob

        with direct_vm.expect_revert("already registered"):
            contract.register_work("b1", "Another title", WORK_TEXT, "https://b.example.org/page")
        assert contract.stats()["works"] == 1


class TestChallenge:
    def test_a_stranger_can_revoke_a_false_record(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)

        out = challenge(contract, direct_vm, direct_bob, challenge_verdict("upheld"))
        assert out["verdict"] == "upheld"
        assert out["revoked"] is True
        assert out["challenger"] == who(direct_bob)

        work = contract.get_work("essay-1")
        assert work["revoked"] is True
        assert work["revoked_by"] == who(direct_bob)
        assert work["revoked_reason"]
        assert work["challenges"] == 1

        history = contract.challenges_of("essay-1")
        assert len(history) == 1
        assert history[0]["verdict"] == "upheld"
        assert history[0]["evidence_url"] == EVIDENCE

    def test_a_revoked_work_cannot_be_attested(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        challenge(contract, direct_vm, direct_bob, challenge_verdict("upheld"))

        with direct_vm.expect_revert("revoked"):
            contract.attest_copy("essay-1", SUSPECT)

    def test_a_revoked_work_frees_the_text_for_the_real_author(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        challenge(contract, direct_vm, direct_bob, challenge_verdict("upheld"))

        out = registered(contract, direct_vm, direct_bob, "b1")
        assert out["work_id"] == "b1"
        assert contract.stats()["works"] == 2
        assert contract.stats()["revoked"] == 1
        assert contract.get_work("b1")["revoked"] is False

    def test_the_owner_cannot_challenge_their_own_record(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice

        with direct_vm.expect_revert("owner cannot challenge"):
            contract.challenge_work("essay-1", EVIDENCE, "This text was published earlier at another URL.")

    def test_a_rejected_challenge_keeps_the_record(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        out = challenge(contract, direct_vm, direct_bob, challenge_verdict("rejected", "no earlier publication found"))

        assert out["verdict"] == "rejected"
        assert out["revoked"] is False
        work = contract.get_work("essay-1")
        assert work["revoked"] is False
        assert work["challenges"] == 1
        assert contract.challenges_of("essay-1")[0]["verdict"] == "rejected"


class TestAttest:
    def test_a_near_copy_is_scored_and_stored(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)

        out = attest(contract, direct_vm, direct_bob, verdict())

        assert out["seq"] == 1
        assert out["category"] == "near_copy"
        assert out["overlap"] == "high"
        assert out["score"] == 85
        assert out["status"] == "near_copy"
        assert out["caller"] == who(direct_bob)
        assert out["excerpt"] == "a matched sentence"
        assert out["claimed"] is False

        work = contract.get_work("essay-1")
        assert work["attestations"] == 1
        assert work["status"] == "near_copy"
        assert work["suspect"] == SUSPECT
        assert work["checked"] is True

    def test_verbatim_and_full_scores_one_hundred(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        out = attest(contract, direct_vm, direct_alice, verdict("verbatim", "full"))
        assert out["score"] == 100
        assert out["status"] == "verbatim"

    def test_a_derivative_with_medium_overlap_needs_review(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        out = attest(contract, direct_vm, direct_alice, verdict("derivative", "medium"))
        assert out["score"] == 50
        assert out["status"] == "review"

    def test_an_unrelated_page_is_clear(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        out = attest(contract, direct_vm, direct_alice, verdict("unrelated", "none", ""))
        assert out["score"] == 0
        assert out["status"] == "clear"

    def test_the_score_never_goes_below_zero(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        out = attest(contract, direct_vm, direct_alice, verdict("unrelated", "low", ""))
        assert out["score"] == 5
        assert out["status"] == "clear"

    def test_a_work_cannot_be_attested_against_its_own_url(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("own published URL"):
            contract.attest_copy("essay-1", ORIGIN)

    def test_an_unreadable_page_stores_nothing(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        direct_vm.clear_mocks()
        direct_vm.mock_web(r"copy\.example\.org", {"status": 200, "body": "   "})
        mock(direct_vm, verdict())
        direct_vm.sender = direct_alice

        with direct_vm.expect_revert("no readable text"):
            contract.attest_copy("essay-1", SUSPECT)
        assert contract.get_work("essay-1")["attestations"] == 0

    def test_a_broken_answer_stores_nothing(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)

        with direct_vm.expect_revert("is not one of"):
            attest(contract, direct_vm, direct_alice, verdict("copied", "high"))
        assert contract.get_work("essay-1")["attestations"] == 0
        assert contract.stats()["attestations"] == 0

    def test_every_round_is_kept_in_order(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        attest(contract, direct_vm, direct_bob, verdict("near_copy", "high"))
        attest(contract, direct_vm, direct_bob, verdict("unrelated", "none", ""))

        history = contract.attestations_of("essay-1")
        assert [c["seq"] for c in history] == [1, 2]
        assert [c["status"] for c in history] == ["near_copy", "clear"]
        assert history[0]["suspect_url"] == SUSPECT
        latest = contract.get_work("essay-1")
        assert latest["status"] == "clear"
        assert latest["attestations"] == 2
        assert contract.stats()["attestations"] == 2
        assert contract.stats()["statuses"] == {"clear": 1, "review": 0, "near_copy": 1, "verbatim": 0}

    def test_works_of_returns_only_that_owner(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice, "a1")
        registered(contract, direct_vm, direct_bob, "b1", WORK_TEXT + " A second draft.")

        assert contract.works_of(who(direct_alice)) == ["a1"]
        assert contract.works_of(who(direct_bob)) == ["b1"]
        ids = [w["id"] for w in contract.list_works(0, 10)]
        assert ids == ["b1", "a1"]


class TestClaim:
    def test_the_owner_can_claim_a_near_copy(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        attest(contract, direct_vm, direct_bob, verdict("near_copy", "high"))

        direct_vm.sender = direct_alice
        out = contract.claim_copy("essay-1", 1)
        assert out["claimed"] is True
        assert out["claimed_by"] == who(direct_alice)
        assert out["claimed_at"] > 0

        work = contract.get_work("essay-1")
        assert work["claims"] == 1
        assert contract.attestations_of("essay-1")[0]["claimed"] is True

    def test_only_the_owner_can_claim(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        attest(contract, direct_vm, direct_bob, verdict("near_copy", "high"))

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the owner"):
            contract.claim_copy("essay-1", 1)

    def test_a_clear_finding_cannot_be_claimed(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        registered(contract, direct_vm, direct_alice)
        attest(contract, direct_vm, direct_alice, verdict("unrelated", "none", ""))

        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("cannot be claimed"):
            contract.claim_copy("essay-1", 1)
