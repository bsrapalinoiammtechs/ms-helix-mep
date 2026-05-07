import mongoose from "mongoose";

const MONGO_URI: string = process.env.MONGO_DB || "";

const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Conectado a MongoDB");
  } catch (error) {
    console.error("Error conectándose a MongoDB", error);
    process.exit(1);
  }
};

export default connectDB;
