import BN from 'bignumber.js'
import { Hop } from '@hop-protocol/sdk'
import { chains, currencyToUnit, unitToCurrency } from '@liquality/cryptoassets'
import { ethers, Wallet } from 'ethers'
import { v4 as uuidv4 } from 'uuid'
import { createClient } from 'urql'
import { SwapProvider } from '../SwapProvider'
import cryptoassets from '../../utils/cryptoassets'
import { ChainNetworks } from '@/utils/networks'
import buildConfig from '../../build.config'
import { withInterval, withLock } from '../../store/actions/performNextAction/utils'
import { prettyBalance } from '../../utils/coinFormatter'

class HopSwapProvider extends SwapProvider {
  constructor(config) {
    super(config)
    this._apiCache = {}
  }
  /**
   * Get the supported pairs of this provider for this network
   * @param {{ network }} network
   */
  // eslint-disable-next-line no-unused-vars
  async getSupportedPairs() {
    return []
  }

  /**
   * Get a quote for the specified parameters
   * @param {{ network, from, to, amount }} options
   */

  graphqlURLs = {
    url: 'https://api.thegraph.com/subgraphs/name/hop-protocol',
    ethereum: 'hop-mainnet',
    xdai: 'hop-xdai',
    arbitrum: 'hop-arbitrum',
    polygon: 'hop-polygon',
    optimism: 'hop-optimism',
  }

  // L2->L1 or L2->L2
  GQL_getDestinationTxHashFromL2Source(transferId) {
    return `query {
        withdrawalBondeds(
          where: {
            transferId: "${transferId}"
          }
        ) {
          timestamp
          amount
          transactionHash
          token
          timestamp
        }
      }
    `
  }
  // L1->L2
  GQL_getDestinationTxHashFromL1Source(recipient) {
    return `query {
        transferFromL1Completeds(
          where: {
            recipient: "${recipient}"
          },
          orderBy: timestamp,
          orderDirection: desc
        ) {
          timestamp
          amount
          transactionHash
          token
          timestamp
        }
      }
    `
  }

  GQL_getTransferIdByTxHash(txHash) {
    return `query {
        transferSents(
          where: {
            transactionHash: "${txHash}"
          }
        ) {
          timestamp
          transferId
          amount
          bonderFee
          transactionHash
          token
          timestamp
        }
      }
    `
  }

  getDestinationTxGQL(transferId, recipient, isFromL1Source) {
    return isFromL1Source
      ? this.GQL_getDestinationTxHashFromL1Source(recipient)
      : this.GQL_getDestinationTxHashFromL2Source(transferId)
  }

  _getApi(network, asset) {
    const fromChain = cryptoassets[asset].chain
    const chainId = ChainNetworks[fromChain][network].chainId
    if (chainId in this._apiCache) {
      return this._apiCache[chainId]
    } else {
      const api = new ethers.providers.InfuraProvider(chainId, buildConfig.infuraApiKey)
      this._apiCache[chainId] = api
      return api
    }
  }

  _getHop(network, signer = undefined) {
    if (!network) return null
    return new Hop(network === 'mainnet' ? 'mainnet' : 'kovan', signer)
  }

  _getAllTokens(hop) {
    const bridge = hop.bridge('ETH')
    const token = bridge.getCanonicalToken(hop.Chain.Ethereum)
    return token.addresses
  }

  _getChain(chain) {
    switch (chain) {
      case Hop.Chain.Ethereum.slug:
        return Hop.Chain.Ethereum
      case Hop.Chain.Arbitrum.slug:
        return Hop.Chain.Arbitrum
      case Hop.Chain.Gnosis.slug:
        return Hop.Chain.Gnosis
      case Hop.Chain.Optimism.slug:
        return Hop.Chain.Optimism
      case Hop.Chain.Polygon.slug:
        return Hop.Chain.Polygon
      default:
        return null
    }
  }

  _getToken(tokenNames) {
    let name
    for (const token of tokenNames) {
      if (name) return name
      switch (token) {
        case Hop.Token.DAI:
          name = Hop.Token.DAI
          break
        case Hop.Token.ETH:
        case Hop.Token.WETH:
          name = Hop.Token.ETH
          break
        case Hop.Token.MATIC:
        case Hop.Token.WMATIC:
          name = Hop.Token.MATIC
          break
        case Hop.Token.USDC:
          name = Hop.Token.USDC
          break
        case Hop.Token.USDT:
          name = Hop.Token.USDT
          break
        case Hop.Token.WBTC:
          return Hop.Token.WBTC
        case Hop.Token.XDAI:
        case Hop.Token.WXDAI:
          name = Hop.Token.XDAI
          break
        default:
          break
      }
    }
    return name
  }

  async _getBridgeWithSigner(hopAsset, hopChainFrom, network, walletId, from, fromAccountId) {
    const chainFrom = this._getChain(hopChainFrom.slug)
    const client = this.getClient(network, walletId, from, fromAccountId)
    const privKey = await client.wallet.exportPrivateKey()
    const hop = this._getHop(network)
    const provider = hop.getChainProvider(chainFrom)
    const signer = new Wallet(privKey, provider)
    const bridge = hop.connect(signer).bridge(hopAsset)
    return bridge
  }

  _getBridgeAsset(chainFrom, chainTo, assetFrom, assetTo, hop) {
    if (!chainFrom || !chainTo || !assetFrom || !assetTo || !hop) return null
    const supportedAssetsFrom = hop.getSupportedAssetsForChain(chainFrom)
    const supportedAssetsTo = hop.getSupportedAssetsForChain(chainTo)
    if (!supportedAssetsFrom[assetFrom] || !supportedAssetsTo[assetTo]) {
      return null
    }
    return assetFrom
  }

  _findAsset(asset, chain, tokens, tokenName) {
    if (asset.type === 'native') {
      if (this._getToken([asset.code, asset.matchingAsset]) === tokenName) {
        return tokenName
      }
    } else {
      if (
        (chain === 'ethereum' &&
          tokens[chain]?.l1CanonicalToken?.toLowerCase() ===
            asset?.contractAddress.toLowerCase()) ||
        tokens[chain]?.l2CanonicalToken?.toLowerCase() === asset?.contractAddress.toLowerCase()
      ) {
        return tokenName
      }
    }
  }

  _getCompatibleAssets(from, to, chainFrom, chainTo, hop) {
    if (!from || !to) return null
    const availableToken = this._getAllTokens(hop)
    let _from, _to
    for (const t in availableToken) {
      if (!_from) _from = this._findAsset(from, chainFrom, availableToken[t], t)
      if (!_to) _to = this._findAsset(to, chainTo, availableToken[t], t)
    }
    if (!_from || !_to || _from !== _to) return null
    return { _from, _to }
  }

  _getInfo(chainFrom, chainTo, hop, _assetFrom, _assetTo) {
    let bridgeAsset, _chainFrom, _chainTo
    _chainFrom = this._getChain(chainFrom)
    _chainTo = this._getChain(chainTo)
    const assets = this._getCompatibleAssets(_assetFrom, _assetTo, chainFrom, chainTo, hop)
    if (!assets?._from || !assets?._to) return null
    const { _from, _to } = assets
    bridgeAsset = this._getBridgeAsset(chainFrom, chainTo, _from, _to, hop)
    return { bridgeAsset, _chainFrom, _chainTo }
  }

  getSendInfo(assetFrom, assetTo, hop) {
    const info = this._getInfo(assetFrom.chain, assetTo.chain, hop, assetFrom, assetTo)
    if (!info?.bridgeAsset || !info?._chainFrom || !info?._chainTo) return null
    return { bridgeAsset: info.bridgeAsset, chainFrom: info._chainFrom, chainTo: info._chainTo }
  }

  // eslint-disable-next-line no-unused-vars
  async getQuote({ network, from, to, amount }) {
    if (amount <= 0) return null
    const assetFrom = cryptoassets[from]
    const assetTo = cryptoassets[to]
    const fromAmountInUnit = currencyToUnit(cryptoassets[from], BN(amount))
    const hop = this._getHop(network)
    if (!hop || !hop.isValidChain(assetFrom.chain) || !hop.isValidChain(assetTo.chain)) return null
    const info = this.getSendInfo(assetFrom, assetTo, hop)
    if (!info?.bridgeAsset || !info?.chainFrom || !info?.chainTo) return null
    const { bridgeAsset, chainFrom, chainTo } = info
    const bridge = hop.bridge(bridgeAsset)
    const sendData = await bridge.getSendData(fromAmountInUnit.toString(), chainFrom, chainTo)
    if (!sendData) return null
    const toAmountInUnit = currencyToUnit(assetFrom, BN(amount).times(sendData.rate))
    return {
      from,
      to,
      // Amounts should be in BigNumber to prevent loss of precision
      fromAmount: fromAmountInUnit,
      toAmount: toAmountInUnit,
      bonderFee: sendData.adjustedBonderFee.toString(),
      destinationFee: sendData.adjustedDestinationTxFee.toString(),
      hopAsset: bridgeAsset,
      hopChainFrom: chainFrom,
      hopChainTo: chainTo
    }
  }


  async approveToken(bridge, chainFrom, chainTo, fromAmount) {
    const approveTx = await bridge.sendApproval(fromAmount, chainFrom, chainTo)
    return {
      status: 'WAITING_FOR_APPROVE_CONFIRMATIONS',
      approveTx,
      approveTxHash: approveTx?.hash
    }
  }

  

  async sendSwap({ network, walletId, quote }) {
    const { hopAsset, hopChainFrom, hopChainTo, from, fromAccountId, fromAmount } = quote
    const chainFrom = this._getChain(hopChainFrom.slug)
    const chainTo = this._getChain(hopChainTo.slug)
    const bridge = await this._getBridgeWithSigner(
      hopAsset,
      hopChainFrom,
      network,
      walletId,
      from,
      fromAccountId
    )
    const swapTx = await bridge.send(fromAmount, chainFrom, chainTo)
    return {
      status: 'WAITING_FOR_SEND_SWAP_CONFIRMATIONS',
      swapTx,
      swapTxHash: swapTx.hash
    }
  }

  /**
   * Create a new swap for the given quote
   * @param {{ network, walletId, quote }} options
   */
  // eslint-disable-next-line no-unused-vars
  async newSwap({ network, walletId, quote }) {
    const { hopAsset, hopChainFrom, hopChainTo, from, fromAccountId, fromAmount } = quote
    const chainFrom = this._getChain(hopChainFrom.slug)
    const chainTo = this._getChain(hopChainTo.slug)
    const bridge = await this._getBridgeWithSigner(
      hopAsset,
      hopChainFrom,
      network,
      walletId,
      from,
      fromAccountId
    )
    const updates = await this.approveToken(bridge, chainFrom, chainTo, fromAmount)
    return {
      id: uuidv4(),
      fee: quote.fee,
      slippage: 50,
      hopAsset: hopAsset,
      hopChainFrom: chainFrom,
      hopChainTo: chainTo,
      ...updates
    }
  }

  /**
   * Estimate the fees for the given parameters
   * @param {{ network, walletId, asset, fromAccountId, toAccountId, txType, amount, feePrices[], max }} options
   * @return Object of key feePrice and value fee
   */
  // eslint-disable-next-line no-unused-vars
  async estimateFees({ txType, quote, feePrices }) {
    const chain = cryptoassets[quote.from].chain
    const nativeAsset = chains[chain].nativeAsset
    if (txType in HopSwapProvider.txTypes) {
      const fees = {}
      for (const feePrice of feePrices) {
        const fee = BN(quote.bonderFee).plus(quote.destinationFee)
        fees[feePrice] = unitToCurrency(cryptoassets[nativeAsset], fee)
      }
      return fees
    }
  }

  async waitForApproveConfirmations({ swap, network, walletId }) {
    const client = this.getClient(network, walletId, swap.from, swap.fromAccountId)
    try {
      const tx = await client.chain.getTransactionByHash(swap.approveTxHash)
      if (tx && tx.confirmations > 0) {
        return {
          endTime: Date.now(),
          status: 'APPROVE_CONFIRMED'
        }
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e)
      else throw e
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  async waitForSendSwapConfirmations({ swap, network, walletId }) {
    const client = this.getClient(network, walletId, swap.from, swap.fromAccountId)
    try {
      const tx = await client.chain.getTransactionByHash(swap.swapTxHash)
      if (tx && tx.confirmations > 0) {
        this.updateBalances(network, walletId, [swap.from])
        return {
          endTime: Date.now(),
          status: Number(tx.status) === 1 ? 'WAITING_FOR_RECIEVE_SWAP_CONFIRMATIONS' : 'FAILED'
        }
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e)
      else throw e
    }
  }

  async waitForRecieveSwapConfirmations({ swap, network, walletId }) {
    const { hopChainFrom, hopChainTo, swapTxHash, from, to, fromAccountId } = swap
    const client = this.getClient(network, walletId, from, fromAccountId)
    const privKey = await client.wallet.exportPrivateKey()
    const signer = new Wallet(privKey)
    const chainFrom = this._getChain(hopChainFrom.slug)
    const chainTo = this._getChain(hopChainTo.slug)
    const isFromL1Source = chainFrom.isL1 && !chainTo.isL1
    try {
      let clientGQL
      let transferId = ''
      if (!isFromL1Source) {
        clientGQL = createClient({
          url: `${this.graphqlURLs.url}/${this.graphqlURLs[chainFrom.slug]}`
        })
        const { data } = await clientGQL
          .query(this.GQL_getTransferIdByTxHash(swapTxHash))
          .toPromise()

        transferId = data.transferSents?.[0].transferId
      }
      clientGQL = createClient({
        url: `${this.graphqlURLs.url}/${this.graphqlURLs[chainTo.slug]}`
      })
      const { data } = await clientGQL
        .query(this.getDestinationTxGQL(transferId, signer.address, isFromL1Source))
        .toPromise()

      const client = this.getClient(network, walletId, to, fromAccountId)
      const tx = await client.chain.getTransactionByHash(
        data[!isFromL1Source ? 'withdrawalBondeds' : 'transferFromL1Completeds']?.[0]
          .transactionHash
      )
      if (tx && tx.confirmations > 0) {
        return {
          endTime: Date.now(),
          status: tx.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED'
        }
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e)
      else throw e
    }
  }

  /**
   * This hook is called when state updates are required
   * @param {object} store
   * @param {{ network, walletId, swap }}
   * @return updates An object representing updates to the current swap in the history
   */
  // eslint-disable-next-line no-unused-vars
  async performNextSwapAction(store, { network, walletId, swap }) {
    let updates

    switch (swap.status) {
      case 'WAITING_FOR_APPROVE_CONFIRMATIONS':
        updates = await withInterval(async () =>
          this.waitForApproveConfirmations({ swap, network, walletId })
        )
        break
      case 'APPROVE_CONFIRMED':
        updates = await withLock(
          store,
          { item: swap, network, walletId, asset: swap.from },
          async () => this.sendSwap({ quote: swap, network, walletId,  })
        )
        break
      case 'WAITING_FOR_SEND_SWAP_CONFIRMATIONS':
        updates = await withInterval(async () =>
          this.waitForSendSwapConfirmations({ swap, network, walletId })
        )
        console.log('updates ->', updates)
        break
      case 'WAITING_FOR_RECIEVE_SWAP_CONFIRMATIONS':
        updates = await withInterval(async () =>
          this.waitForRecieveSwapConfirmations({ swap, network, walletId })
        )
        break
    }
    return updates
  }

  static txTypes = {
    SWAP: 'SWAP'
  }

  static statuses = {
    WAITING_FOR_APPROVE_CONFIRMATIONS: {
      step: 0,
      label: 'Approving {from}',
      filterStatus: 'PENDING',
      notification(swap) {
        return {
          message: `Approving ${swap.from}`
        }
      }
    },
    APPROVE_CONFIRMED: {
      step: 1,
      label: 'Swapping {from}',
      filterStatus: 'PENDING'
    },
    WAITING_FOR_SEND_SWAP_CONFIRMATIONS: {
      step: 1,
      label: 'Swapping {from}',
      filterStatus: 'PENDING',
      notification() {
        return {
          message: 'Engaging the unicorn'
        }
      }
    },
    WAITING_FOR_RECIEVE_SWAP_CONFIRMATIONS: {
      step: 2,
      label: 'Swapping {to}',
      filterStatus: 'PENDING',
      notification() {
        return {
          message: 'Engaging the unicorn'
        }
      }
    },
    SUCCESS: {
      step: 3,
      label: 'Completed',
      filterStatus: 'COMPLETED',
      notification(swap) {
        console.log('swap ->', swap);
        return {
          message: `Swap completed, ${prettyBalance(swap.toAmount, swap.to)} ${
            swap.to
          } ready to use`
        }
      }
    },
    FAILED: {
      step: 3,
      label: 'Swap Failed',
      filterStatus: 'REFUNDED',
      notification() {
        return {
          message: 'Swap failed'
        }
      }
    }
  }

  static fromTxType = HopSwapProvider.txTypes.SWAP
  static toTxType = null

  static timelineDiagramSteps = ['APPROVE', 'INITIATION', 'RECEIVE']

  static totalSteps = 4
}

export { HopSwapProvider }
