// The bcrypt cost factor, in one place.
//
// It was written twice — inline in the register route and as a constant in the
// two-factor service — which is the shape a security parameter should never
// have: the day somebody raises it, they raise one of them.
//
// **Under NODE_ENV=test it drops to bcrypt's minimum**, and that is deliberate
// rather than a corner cut. A cost factor is a *time* parameter: its entire
// job is to make one hash expensive. The suites register several hundred users
// and hash thousands of two-factor backup codes (eight per setup), so running
// them at the production cost measures this machine's CPU, not this code — and
// on a loaded machine it measures it badly enough that `beforeAll` hooks blow
// Jest's five-second limit and unrelated suites go red.
//
// Nothing about what the tests *prove* changes: the algorithm, the salt, the
// stored format and the compare path are identical, and the property under
// test — the right password verifies and the wrong one does not — is not a
// function of the cost. Production reads PRODUCTION_ROUNDS, and a hash written
// at any cost still verifies, because the cost travels in the hash.

// 10 is the figure the app has always used: comfortably above the point where
// a GPU makes short work of a list, comfortably below the point where a login
// feels slow.
const PRODUCTION_ROUNDS = 10

// bcrypt's floor. Fast enough that hashing stops showing up in a test profile.
const TEST_ROUNDS = 4

// Read per call rather than captured at import, so a suite that sets
// NODE_ENV after requiring this still gets the right answer.
function rounds() {
  return process.env.NODE_ENV === 'test' ? TEST_ROUNDS : PRODUCTION_ROUNDS
}

module.exports = { rounds, PRODUCTION_ROUNDS, TEST_ROUNDS }
