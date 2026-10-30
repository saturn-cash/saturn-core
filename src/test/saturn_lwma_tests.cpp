// Copyright (c) 2026-present The Saturn Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <arith_uint256.h>
#include <chain.h>
#include <chainparams.h>
#include <pow.h>
#include <test/util/setup_common.h>
#include <util/chaintype.h>

#include <boost/test/unit_test.hpp>

#include <vector>

BOOST_FIXTURE_TEST_SUITE(saturn_lwma_tests, BasicTestingSetup)

namespace {
//! Build a chain on the Saturn mainnet parameters. blocks[i] = {timestamp, nBits}; returns index storage.
std::vector<CBlockIndex> MakeChain(const std::vector<std::pair<int64_t, uint32_t>>& blocks)
{
    std::vector<CBlockIndex> chain(blocks.size());
    for (size_t i = 0; i < blocks.size(); ++i) {
        chain[i].pprev = i ? &chain[i - 1] : nullptr;
        chain[i].nHeight = i;
        chain[i].nTime = blocks[i].first;
        chain[i].nBits = blocks[i].second;
        chain[i].BuildSkip();
    }
    return chain;
}

double Difficulty(uint32_t bits)
{
    arith_uint256 t;
    t.SetCompact(bits);
    arith_uint256 one;
    one.SetCompact(0x1d00ffff);
    return (one.getdouble() / t.getdouble());
}

//! Next nBits on top of `chain` (height = chain.size()).
uint32_t Next(const std::vector<CBlockIndex>& chain, const Consensus::Params& p)
{
    CBlockHeader h;
    h.nTime = chain.back().nTime + p.nPowTargetSpacing;
    return GetNextWorkRequired(&chain.back(), &h, p);
}
} // namespace

BOOST_AUTO_TEST_CASE(mainnet_params)
{
    const auto params = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& p = params->GetConsensus();
    BOOST_CHECK_EQUAL(p.nLWMAHeight, 7);
    BOOST_CHECK_EQUAL(p.nLWMAWindow, 45);
    BOOST_CHECK_CLOSE(Difficulty(p.nLWMAStartBits), 65536.0, 0.01);
    // other chains keep Bitcoin's behaviour
    const auto reg = CreateChainParams(*m_node.args, ChainType::REGTEST);
    BOOST_CHECK_EQUAL(reg->GetConsensus().nLWMAHeight, std::numeric_limits<int>::max());
}

BOOST_AUTO_TEST_CASE(legacy_then_fork_block)
{
    const auto params = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& p = params->GetConsensus();
    // genesis + 6 blocks, each 4x harder than the last, as the live chain did
    std::vector<std::pair<int64_t, uint32_t>> b{{1779650000, 0x1d07ffff}};
    for (int i = 1; i <= 6; ++i) {
        auto chain = MakeChain(b);
        uint32_t bits = Next(chain, p);
        // legacy rule: 4x per block
        BOOST_CHECK_CLOSE(Difficulty(bits), Difficulty(b.back().second) * 4, 0.1);
        b.emplace_back(b.back().first + 600, bits);
    }
    BOOST_CHECK_CLOSE(Difficulty(b.back().second), 512.0, 0.1); // block 6, matches the live chain (0x1b7fffc0)
    // block 7 is the first LWMA block: it resets to the start difficulty
    auto chain = MakeChain(b);
    BOOST_CHECK_EQUAL(Next(chain, p), p.nLWMAStartBits);
}

BOOST_AUTO_TEST_CASE(steady_and_adjusting)
{
    const auto params = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& p = params->GetConsensus();
    std::vector<std::pair<int64_t, uint32_t>> base;
    int64_t t = 1779650000;
    for (int i = 0; i < 7; ++i) base.emplace_back(t += 600, 0x1d07ffff);
    base.back().second = p.nLWMAStartBits; // block 7

    // on-time blocks: difficulty stays put
    {
        auto b = base;
        for (int i = 0; i < 100; ++i) {
            uint32_t bits = Next(MakeChain(b), p);
            b.emplace_back(b.back().first + 600, bits);
        }
        BOOST_CHECK_CLOSE(Difficulty(b.back().second), 65536.0, 1.0);
    }
    // 4x the hashrate (blocks every 150s): difficulty converges up to about 4x and blocks slow to ~600s
    {
        auto b = base;
        const double hashrate = 65536.0 * 4 / 600; // difficulty-units per second
        for (int i = 0; i < 300; ++i) {
            uint32_t bits = Next(MakeChain(b), p);
            const int64_t solve = std::max<int64_t>(1, Difficulty(bits) / hashrate);
            b.emplace_back(b.back().first + solve, bits);
        }
        BOOST_CHECK_CLOSE(Difficulty(b.back().second), 65536.0 * 4, 10.0);
    }
    // a 5-month gap counts as at most 6 spacings: difficulty drops, but not to the floor
    {
        auto b = base;
        for (int i = 0; i < 50; ++i) b.emplace_back(b.back().first + 600, Next(MakeChain(b), p));
        b.emplace_back(b.back().first + 150 * 24 * 3600, Next(MakeChain(b), p));
        const double after = Difficulty(Next(MakeChain(b), p));
        BOOST_CHECK(after < 65536.0);
        BOOST_CHECK(after > 65536.0 / 2);
    }
    // timestamps going backwards cannot produce zero or negative solve times
    {
        auto b = base;
        for (int i = 0; i < 60; ++i) b.emplace_back(b.back().first + (i % 2 ? -300 : 900), Next(MakeChain(b), p));
        const double d = Difficulty(Next(MakeChain(b), p));
        BOOST_CHECK(d > 1000 && d < 1e7);
    }
}

BOOST_AUTO_TEST_CASE(presync_bound_disabled_after_fork)
{
    const auto params = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& p = params->GetConsensus();
    // a 32x jump at the fork block would break Bitcoin's 4x bound; header presync must allow it
    BOOST_CHECK(PermittedDifficultyTransition(p, 7, 0x1b7fffc0, p.nLWMAStartBits));
    BOOST_CHECK(PermittedDifficultyTransition(p, 8, p.nLWMAStartBits, 0x1a00ffff));
    // before the fork the old rule still applies
    BOOST_CHECK(!PermittedDifficultyTransition(p, 6, 0x1d07ffff, 0x1b00ffff));
}

BOOST_AUTO_TEST_SUITE_END()
