# Current risks

- Native Windows compilation requires missing MSVC C++ Build Tools. Local Rust installation can proceed; browser work and core design are independent. User asked about installer setup.
- macOS runtime/build/signing cannot be verified on this Windows host. Add CI; do not claim platform success without execution evidence.
- Credentials and public publishing are release gates, not permission to stop P0 implementation.
