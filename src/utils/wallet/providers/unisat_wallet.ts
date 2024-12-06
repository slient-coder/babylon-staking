import { Psbt, address, networks } from "bitcoinjs-lib";

import {
  getNetworkConfig,
  network,
  validateAddress,
} from "@/config/network.config";

import {
  getAddressBalance,
  getFundingUTXOs,
  getNetworkFees,
  getTipHeight,
  pushTx,
} from "../../mempool_api";
import {
  Fees,
  InscriptionIdentifier,
  Network,
  UTXO,
  WalletInfo,
  WalletProvider,
} from "../wallet_provider";

// window object for UniSat Wallet extension
export const unisatProvider = "unisat";

enum ChainType {
  BITCOIN_MAINNET = "BITCOIN_MAINNET",
  BITCOIN_TESTNET = "BITCOIN_TESTNET",
  BITCOIN_SIGNET = "BITCOIN_SIGNET",
  FRACTAL_BITCOIN_MAINNET = "FRACTAL_BITCOIN_MAINNET",
  FRACTAL_BITCOIN_TESTNET = "FRACTAL_BITCOIN_TESTNET",
}

export class UniSatWallet extends WalletProvider {
  private unisatWalletInfo: WalletInfo | undefined;
  private networkEnv: Network | undefined;
  private chainType: ChainType | undefined;

  constructor() {
    super();

    this.networkEnv = getNetworkConfig().network;

    switch (this.networkEnv) {
      case Network.MAINNET:
        this.chainType = ChainType.BITCOIN_MAINNET;
        break;
      case Network.TESTNET:
        this.chainType = ChainType.BITCOIN_TESTNET;
        break;
      case Network.SIGNET:
        this.chainType = ChainType.BITCOIN_SIGNET;
        break;
      default:
        throw new Error("Unsupported network");
    }
  }

  private get provider() {
    return window[unisatProvider];
  }

  connectWallet = async (): Promise<this> => {
    // check whether there is an UniSat Wallet extension
    if (!this.provider) {
      throw new Error("UniSat Wallet extension not found");
    }

    let address = "";
    let pubkey = "";
    try {
      await this.checkNetwork();
      const accounts = await this.provider.requestAccounts(); // Connect to UniSat Wallet extension

      address = accounts[0];
      pubkey = await this.provider.getPublicKey();
    } catch (error) {
      if ((error as Error)?.message?.includes("rejected")) {
        throw new Error("Connection to UniSat Wallet was rejected");
      } else {
        throw new Error((error as Error)?.message);
      }
    }

    validateAddress(network, address);

    if (pubkey && address) {
      this.unisatWalletInfo = {
        publicKeyHex: pubkey,
        address,
      };
      return this;
    } else {
      throw new Error("Could not connect to UniSat Wallet");
    }
  };

  checkNetwork = async (): Promise<void> => {
    if (this.provider.getChain == undefined) {
      throw new Error(
        "Please update your UniSat Wallet to the latest version.",
      );
    }
    if (this.chainType !== (await this.provider.getChain())) {
      await this.provider.switchChain(this.chainType);
    }
  };

  getWalletProviderName = async (): Promise<string> => {
    return "UniSat";
  };

  getAddress = async (): Promise<string> => {
    if (!this.unisatWalletInfo) {
      throw new Error("UniSat Wallet not connected");
    }
    return this.unisatWalletInfo.address;
  };

  getPublicKeyHex = async (): Promise<string> => {
    if (!this.unisatWalletInfo) {
      throw new Error("UniSat Wallet not connected");
    }
    return this.unisatWalletInfo.publicKeyHex;
  };

  private getSignPsbtDefaultOptions(psbtHex: string) {
    const toSignInputs: any[] = [];
    const psbt = Psbt.fromHex(psbtHex);
    psbt.data.inputs.forEach((input, index) => {
      const signed = input.finalScriptSig || input.finalScriptWitness;

      let useTweakedSigner = false;
      if (input.witnessUtxo && input.witnessUtxo.script) {
        let network = networks.bitcoin;
        if (this.networkEnv === Network.TESTNET) {
          network = networks.testnet;
        } else if (this.networkEnv === Network.SIGNET) {
          network = networks.testnet;
        }

        const addressToBeSigned = address.fromOutputScript(
          input.witnessUtxo.script,
          network,
        );

        // check if the address is a taproot address
        const isTaproot =
          addressToBeSigned.indexOf("tb1p") === 0 ||
          addressToBeSigned.indexOf("bc1p") === 0;

        // check if the address is the same as the wallet address
        const isWalletAddress =
          addressToBeSigned === this.unisatWalletInfo?.address;

        if (isTaproot && isWalletAddress) {
          useTweakedSigner = true;
        }
      }

      if (!signed) {
        toSignInputs.push({
          index,
          publicKey: this.unisatWalletInfo?.publicKeyHex,
          sighashTypes: undefined,
          useTweakedSigner,
        });
      }
    });
    return {
      autoFinalized: true,
      toSignInputs,
    };
  }

  signPsbt = async (psbtHex: string): Promise<string> => {
    if (!this.unisatWalletInfo) {
      throw new Error("UniSat Wallet not connected");
    }

    // sign the PSBT
    return await this.provider.signPsbt(
      psbtHex,
      this.getSignPsbtDefaultOptions(psbtHex),
    );
  };

  signPsbts = async (psbtsHexes: string[]): Promise<string[]> => {
    if (!this.unisatWalletInfo) {
      throw new Error("UniSat Wallet not connected");
    }
    // sign the PSBTs
    return await this.provider.signPsbts(
      psbtsHexes,
      psbtsHexes.map((v) => this.getSignPsbtDefaultOptions(v)),
    );
  };

  signMessageBIP322 = async (message: string): Promise<string> => {
    if (!this.unisatWalletInfo) {
      throw new Error("UniSat Wallet not connected");
    }
    return await this.provider?.signMessage(message, "bip322-simple");
  };

  getNetwork = async (): Promise<Network> => {
    if (!this.networkEnv) {
      throw new Error("Network not set");
    }
    return this.networkEnv;
  };

  on = (eventName: string, callBack: () => void) => {
    if (!this.unisatWalletInfo) {
      throw new Error("UniSat Wallet not connected");
    }
    // subscribe to account change event
    if (eventName === "accountChanged") {
      return this.provider.on("accountsChanged", callBack);
    }
    return this.provider?.on(eventName, callBack);
  };

  // Mempool calls

  getBalance = async (): Promise<number> => {
    return await getAddressBalance(await this.getAddress());
  };

  getNetworkFees = async (): Promise<Fees> => {
    return await getNetworkFees();
  };

  pushTx = async (txHex: string): Promise<string> => {
    return await pushTx(txHex);
  };

  getUtxos = async (address: string, amount: number): Promise<UTXO[]> => {
    // mempool call
    return await getFundingUTXOs(address, amount);
  };

  getBTCTipHeight = async (): Promise<number> => {
    return await getTipHeight();
  };

  getInscriptions = async (): Promise<InscriptionIdentifier[]> => {
    // max num of iterations to prevent infinite loop
    const MAX_ITERATIONS = 100;
    // Fetch inscriptions in batches of 100
    const limit = 100;
    const inscriptionIdentifiers: InscriptionIdentifier[] = [];
    let cursor = 0;
    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        const { list } = await this.provider.getInscriptions(cursor, limit);
        const identifiers = list.map((i: { output: string }) => {
          const [txid, vout] = i.output.split(":");
          return {
            txid,
            vout,
          };
        });
        inscriptionIdentifiers.push(...identifiers);
        if (list.length < limit) {
          break;
        }
        cursor += limit;
        iterations++;
        if (iterations >= MAX_ITERATIONS) {
          throw new Error(
            "Exceeded maximum iterations when fetching inscriptions",
          );
        }
      }
    } catch (error) {
      throw new Error("Failed to get inscriptions from UniSat Wallet");
    }

    return inscriptionIdentifiers;
  };
}
