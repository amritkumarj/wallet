export const mutations = {
  SET_LEDGER_BRIDGE_CONNECTED(state, { connected }) {
    state.ledgerBridgeConnected = connected
  },
  SET_LEDGER_BRIDGE_TRANSPORT_CONNECTED(state, { connected }) {
    state.ledgerBridgeTransportConnected = connected
  },
  ANALITYCS_STARTED(state) {
    state.analyticsStarted = true
  },
  SET_ANALYTICS_OPTIN_MODAL_OPEN(state, { open }) {
    state.analyticsOptInModalOpen = open
  },
  SET_ORIGIN_ACCESS_ACTIVE(state, { active }) {
    state.requestOriginAccessActive = active
  },
  SET_REQUEST_PERMISSION_ACTIVE(state, { active }) {
    state.requestPermissionActive = active
  },
  SET_BUY_CRYPTO_MODAL_OPEN(state, { open, chain, asset, address }) {
    if (open) {
      state.buyCryptoModalData = { chain, asset, address }
    } else {
      state.buyCryptoModalData = {}
    }
    state.buyCryptoModalOpen = open
  },
  SET_BUY_CRYPTO_OVERVIEW_MODAL_OPEN(state, { open }) {
    state.buyCryptoOverviewModalOpen = open
  },
  SET_LEDGER_SIGN_REQUEST_MODAL_OPEN(state, { open }) {
    state.ledgertSignRequestModalOpen = open
  },
  SET_SETTINGS_MODAL_OPEN(state, { open }) {
    state.settingsModalOpen = open
  }
}
