<template>
  <button @click="open" class="btn" id="buy_crypto_button" :class="btnClass">Buy Crypto</button>
</template>

<script>
import { mapActions } from 'vuex'
export default {
  props: ['asset', 'chain', 'address', 'btnClass', 'screen'],
  methods: {
    ...mapActions('app', ['setBuyCryptoModalOpen']),
    open() {
      const { asset, chain, address, screen } = this
      this.setBuyCryptoModalOpen({ open: true, asset, chain, address, screen })
    }
  }
}
</script>

<style lang="scss" scoped>
.btn {
  border-radius: 22px;

  &:focus {
    color: $primary;
    border-color: $primary;
    background-color: #f8faff;
    border: 1px solid $primary;
  }
}
</style>
