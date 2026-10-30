// Copyright (c) 2009-2010 Satoshi Nakamoto
// Copyright (c) 2009-present The Saturn Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <pow.h>

#include <arith_uint256.h>
#include <chain.h>
#include <primitives/block.h>
#include <uint256.h>
#include <util/check.h>

#include <algorithm>

unsigned int GetNextWorkRequired(const CBlockIndex* pindexLast, const CBlockHeader *pblock, const Consensus::Params& params)
{
    assert(pindexLast != nullptr);
    unsigned int nProofOfWorkLimit = UintToArith256(params.powLimit).GetCompact();

    if (pindexLast->nHeight + 1 >= params.nLWMAHeight) {
        return LwmaNextWorkRequired(pindexLast, params);
    }

    // Only change once per difficulty adjustment interval
    if ((pindexLast->nHeight+1) % params.DifficultyAdjustmentInterval() != 0)
    {
        if (params.fPowAllowMinDifficultyBlocks)
        {
            // Special difficulty rule for testnet:
            // If the new block's timestamp is more than 2* 10 minutes
            // then it MUST be a min-difficulty block.
            if (pblock->GetBlockTime() > pindexLast->GetBlockTime() + params.nPowTargetSpacing*2)
                return nProofOfWorkLimit;
            else
            {
                // Return the last non-special-min-difficulty-rules-block
                const CBlockIndex* pindex = pindexLast;
                while (pindex->pprev && pindex->nHeight % params.DifficultyAdjustmentInterval() != 0 && pindex->nBits == nProofOfWorkLimit)
                    pindex = pindex->pprev;
                return pindex->nBits;
            }
        }
        return pindexLast->nBits;
    }

    // Go back by what we want to be 14 days worth of blocks
    int nHeightFirst = pindexLast->nHeight - (params.DifficultyAdjustmentInterval()-1);
    assert(nHeightFirst >= 0);
    const CBlockIndex* pindexFirst = pindexLast->GetAncestor(nHeightFirst);
    assert(pindexFirst);

    return CalculateNextWorkRequired(pindexLast, pindexFirst->GetBlockTime(), params);
}

/*
 * LWMA-1 (zawy12), Saturn variant. The next target is the average target of the last N blocks,
 * scaled by their linearly weighted mean solve time over the target spacing, so recent blocks
 * count most. Solve times are made monotonic and capped at 6x spacing so bad timestamps cannot
 * swing difficulty far.
 *
 * Window slots that fall before nLWMAHeight are filled with synthetic ideal blocks (solve time =
 * spacing, target = nLWMAStartBits), so the algorithm starts smoothly from nLWMAStartBits instead
 * of from the pre-fork history. The first LWMA block itself uses nLWMAStartBits.
 */
unsigned int LwmaNextWorkRequired(const CBlockIndex* pindexLast, const Consensus::Params& params)
{
    assert(pindexLast != nullptr);
    const int64_t T = params.nPowTargetSpacing;
    const int64_t N = params.nLWMAWindow;
    const int64_t fork = params.nLWMAHeight;
    const int64_t next_height = int64_t{pindexLast->nHeight} + 1;
    const arith_uint256 pow_limit = UintToArith256(params.powLimit);

    arith_uint256 start_target;
    start_target.SetCompact(params.nLWMAStartBits);
    if (start_target == 0 || start_target > pow_limit) start_target = pow_limit;

    if (next_height <= fork) return start_target.GetCompact();

    // weighted sum of solve times, and sum of targets / (k * N) as in the reference implementation
    const int64_t k = N * (N + 1) * T / 2;
    int64_t weighted_time = 0;
    arith_uint256 sum_target;
    // timestamp of the block just before the window; only used once the window is entirely past the
    // fork (otherwise the fork block, which is inside the window, sets it)
    int64_t prev_time = 0;
    if (next_height - N - 1 >= fork) {
        prev_time = pindexLast->GetAncestor(next_height - N - 1)->GetBlockTime();
    }
    for (int64_t j = 1; j <= N; ++j) {
        const int64_t h = next_height - N + j - 1; // heights next_height-N .. next_height-1
        int64_t solvetime;
        arith_uint256 target;
        if (h <= fork) {
            // before (or at) the switch: ideal block at the start target. The fork block's own solve
            // time is measured against pre-fork history and is meaningless, so it is synthetic too.
            solvetime = T;
            target = start_target;
            if (h == fork) {
                prev_time = pindexLast->GetAncestor(h)->GetBlockTime();
                target.SetCompact(pindexLast->GetAncestor(h)->nBits);
            }
        } else {
            const CBlockIndex* block = pindexLast->GetAncestor(h);
            assert(block);
            const int64_t this_time = std::max<int64_t>(block->GetBlockTime(), prev_time + 1);
            solvetime = std::min<int64_t>(6 * T, this_time - prev_time);
            prev_time = this_time;
            target.SetCompact(block->nBits);
        }
        weighted_time += solvetime * j;
        sum_target += target / arith_uint256(static_cast<uint64_t>(k * N));
    }
    // guard against a degenerate window (cannot happen with the monotonic fix, but keep it safe)
    if (weighted_time < k / 10) weighted_time = k / 10;

    arith_uint256 next_target = sum_target * arith_uint256(static_cast<uint64_t>(weighted_time));
    if (next_target > pow_limit || next_target == 0) next_target = pow_limit;
    return next_target.GetCompact();
}

unsigned int CalculateNextWorkRequired(const CBlockIndex* pindexLast, int64_t nFirstBlockTime, const Consensus::Params& params)
{
    if (params.fPowNoRetargeting)
        return pindexLast->nBits;

    // Limit adjustment step
    int64_t nActualTimespan = pindexLast->GetBlockTime() - nFirstBlockTime;
    if (nActualTimespan < params.nPowTargetTimespan/4)
        nActualTimespan = params.nPowTargetTimespan/4;
    if (nActualTimespan > params.nPowTargetTimespan*4)
        nActualTimespan = params.nPowTargetTimespan*4;

    // Retarget
    const arith_uint256 bnPowLimit = UintToArith256(params.powLimit);
    arith_uint256 bnNew;

    // Special difficulty rule for Testnet4
    if (params.enforce_BIP94) {
        // Here we use the first block of the difficulty period. This way
        // the real difficulty is always preserved in the first block as
        // it is not allowed to use the min-difficulty exception.
        int nHeightFirst = pindexLast->nHeight - (params.DifficultyAdjustmentInterval()-1);
        const CBlockIndex* pindexFirst = pindexLast->GetAncestor(nHeightFirst);
        bnNew.SetCompact(pindexFirst->nBits);
    } else {
        bnNew.SetCompact(pindexLast->nBits);
    }

    bnNew *= nActualTimespan;
    bnNew /= params.nPowTargetTimespan;

    if (bnNew > bnPowLimit)
        bnNew = bnPowLimit;

    return bnNew.GetCompact();
}

// Check that on difficulty adjustments, the new difficulty does not increase
// or decrease beyond the permitted limits.
bool PermittedDifficultyTransition(const Consensus::Params& params, int64_t height, uint32_t old_nbits, uint32_t new_nbits)
{
    if (params.fPowAllowMinDifficultyBlocks) return true;
    // LWMA can move difficulty by more than Bitcoin's 4x per period; the exact value is still
    // enforced by ContextualCheckBlockHeader. This check is only an anti-DoS bound for header presync.
    if (height >= params.nLWMAHeight) return true;

    if (height % params.DifficultyAdjustmentInterval() == 0) {
        int64_t smallest_timespan = params.nPowTargetTimespan/4;
        int64_t largest_timespan = params.nPowTargetTimespan*4;

        const arith_uint256 pow_limit = UintToArith256(params.powLimit);
        arith_uint256 observed_new_target;
        observed_new_target.SetCompact(new_nbits);

        // Calculate the largest difficulty value possible:
        arith_uint256 largest_difficulty_target;
        largest_difficulty_target.SetCompact(old_nbits);
        largest_difficulty_target *= largest_timespan;
        largest_difficulty_target /= params.nPowTargetTimespan;

        if (largest_difficulty_target > pow_limit) {
            largest_difficulty_target = pow_limit;
        }

        // Round and then compare this new calculated value to what is
        // observed.
        arith_uint256 maximum_new_target;
        maximum_new_target.SetCompact(largest_difficulty_target.GetCompact());
        if (maximum_new_target < observed_new_target) return false;

        // Calculate the smallest difficulty value possible:
        arith_uint256 smallest_difficulty_target;
        smallest_difficulty_target.SetCompact(old_nbits);
        smallest_difficulty_target *= smallest_timespan;
        smallest_difficulty_target /= params.nPowTargetTimespan;

        if (smallest_difficulty_target > pow_limit) {
            smallest_difficulty_target = pow_limit;
        }

        // Round and then compare this new calculated value to what is
        // observed.
        arith_uint256 minimum_new_target;
        minimum_new_target.SetCompact(smallest_difficulty_target.GetCompact());
        if (minimum_new_target > observed_new_target) return false;
    } else if (old_nbits != new_nbits) {
        return false;
    }
    return true;
}

// Bypasses the actual proof of work check during fuzz testing with a simplified validation checking whether
// the most significant bit of the last byte of the hash is set.
bool CheckProofOfWork(uint256 hash, unsigned int nBits, const Consensus::Params& params)
{
    if (EnableFuzzDeterminism()) return (hash.data()[31] & 0x80) == 0;
    return CheckProofOfWorkImpl(hash, nBits, params);
}

std::optional<arith_uint256> DeriveTarget(unsigned int nBits, const uint256 pow_limit)
{
    bool fNegative;
    bool fOverflow;
    arith_uint256 bnTarget;

    bnTarget.SetCompact(nBits, &fNegative, &fOverflow);

    // Check range
    if (fNegative || bnTarget == 0 || fOverflow || bnTarget > UintToArith256(pow_limit))
        return {};

    return bnTarget;
}

bool CheckProofOfWorkImpl(uint256 hash, unsigned int nBits, const Consensus::Params& params)
{
    auto bnTarget{DeriveTarget(nBits, params.powLimit)};
    if (!bnTarget) return false;

    // Check proof of work matches claimed amount
    if (UintToArith256(hash) > bnTarget)
        return false;

    return true;
}
